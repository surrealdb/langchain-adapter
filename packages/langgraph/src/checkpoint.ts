import {
	BaseCheckpointSaver as BaseLangGraphCheckpointSaver,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointTuple,
	type ChannelVersions,
	type PendingWrite,
	WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
	defineTable,
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const CHECKPOINTS_TABLE = 'langgraph_checkpoints';
const WRITES_TABLE = 'langgraph_checkpoint_writes';
const SUPPORTED_CHECKPOINT_VERSION = 4;

export interface CheckpointSaverArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	serde?: SerializerProtocol;
	checkpointsTable?: string;
	writesTable?: string;
	skipVersionCheck?: boolean;
}

interface CheckpointRow {
	id: { tb: string; id: string } | string;
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
	parent_id: string | null;
	type: string;
	checkpoint: Uint8Array;
	metadata: CheckpointMetadata;
	created_at: string | Date;
}

interface CheckpointWriteRow {
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
	task_id: string;
	idx: number;
	channel: string;
	type: string;
	value: Uint8Array;
}

/**
 * SurrealDB-backed `BaseCheckpointSaver` for LangGraph.js.
 *
 * Persists checkpoints and intermediate writes into two tables in the
 * connected SurrealDB v3 database. Channel values are serialised through
 * the LangGraph serde protocol (defaults to `JsonPlusSerializer`) and
 * stored as native `bytes`.
 */
export class CheckpointSaver extends BaseLangGraphCheckpointSaver {
	readonly client: SurrealDBClient;
	readonly checkpointsTable: string;
	readonly writesTable: string;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: CheckpointSaverArgs) {
		super(args.serde);
		this.checkpointsTable = args.checkpointsTable ?? CHECKPOINTS_TABLE;
		this.writesTable = args.writesTable ?? WRITES_TABLE;
		this.skipVersionCheck = args.skipVersionCheck ?? false;

		if (args.surreal instanceof SurrealDBClient) {
			this.client = args.surreal;
			this.ownsClient = false;
		} else {
			this.client = new SurrealDBClient(args.surreal);
			this.ownsClient = true;
		}
	}

	/**
	 * Create the checkpoint tables and indexes. Idempotent. Must be
	 * called once before the first read or write — `getTuple`/`put`
	 * call it lazily so most users don't need to invoke it directly.
	 */
	async setup(): Promise<void> {
		if (this.setupDone) return;
		await this.client.connect();
		if (!this.skipVersionCheck) {
			await this.client.assertServerVersion();
		}

		await this.client.execute(
			defineTable(this.checkpointsTable, [
				{ name: 'thread_id', type: 'TYPE string' },
				{
					name: 'checkpoint_ns',
					type: "TYPE string DEFAULT ''",
				},
				{ name: 'checkpoint_id', type: 'TYPE string' },
				{ name: 'parent_id', type: 'TYPE option<string>' },
				{ name: 'type', type: 'TYPE string' },
				{ name: 'checkpoint', type: 'TYPE bytes' },
				{ name: 'metadata', type: 'FLEXIBLE TYPE object DEFAULT {}' },
				{
					name: 'created_at',
					type: 'TYPE datetime DEFAULT time::now()',
				},
			]),
		);
		await this.client.execute(
			`DEFINE INDEX IF NOT EXISTS ${this.checkpointsTable}_pk ON ${this.checkpointsTable} ` +
				`FIELDS thread_id, checkpoint_ns, checkpoint_id UNIQUE;`,
		);
		await this.client.execute(
			`DEFINE INDEX IF NOT EXISTS ${this.checkpointsTable}_thread ON ${this.checkpointsTable} ` +
				`FIELDS thread_id, checkpoint_ns, created_at;`,
		);

		await this.client.execute(
			defineTable(this.writesTable, [
				{ name: 'thread_id', type: 'TYPE string' },
				{
					name: 'checkpoint_ns',
					type: "TYPE string DEFAULT ''",
				},
				{ name: 'checkpoint_id', type: 'TYPE string' },
				{ name: 'task_id', type: 'TYPE string' },
				{ name: 'idx', type: 'TYPE int' },
				{ name: 'channel', type: 'TYPE string' },
				{ name: 'type', type: 'TYPE string' },
				{ name: 'value', type: 'TYPE bytes' },
			]),
		);
		await this.client.execute(
			`DEFINE INDEX IF NOT EXISTS ${this.writesTable}_pk ON ${this.writesTable} ` +
				`FIELDS thread_id, checkpoint_ns, checkpoint_id, task_id, idx UNIQUE;`,
		);

		this.setupDone = true;
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	override async getTuple(
		config: RunnableConfig,
	): Promise<CheckpointTuple | undefined> {
		await this.setup();
		const threadId = String(config.configurable?.thread_id ?? '');
		if (!threadId) return undefined;
		const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
		const checkpointId = config.configurable?.checkpoint_id as
			| string
			| undefined;

		const row = checkpointId
			? await this.client.queryOne<CheckpointRow>(
					`SELECT * FROM ${this.checkpointsTable} ` +
						`WHERE thread_id = $tid AND checkpoint_ns = $ns AND checkpoint_id = $cid`,
					{ tid: threadId, ns: checkpointNs, cid: checkpointId },
				)
			: await this.client.queryOne<CheckpointRow>(
					`SELECT * FROM ${this.checkpointsTable} ` +
						`WHERE thread_id = $tid AND checkpoint_ns = $ns ` +
						`ORDER BY checkpoint_id DESC LIMIT 1`,
					{ tid: threadId, ns: checkpointNs },
				);

		if (!row) return undefined;

		const checkpoint = (await this.serde.loadsTyped(
			row.type,
			toBytes(row.checkpoint),
		)) as Checkpoint;

		if (
			typeof checkpoint.v === 'number' &&
			checkpoint.v < SUPPORTED_CHECKPOINT_VERSION
		) {
			throw new Error(
				`CheckpointSaver: refusing to load Checkpoint v${checkpoint.v} ` +
					`(expected v${SUPPORTED_CHECKPOINT_VERSION}+). Migrate the checkpoint ` +
					`upstream (e.g. via @langchain/langgraph-checkpoint-postgres) ` +
					`before reading it back.`,
			);
		}

		const writes = await this.client.queryAll<CheckpointWriteRow>(
			`SELECT * FROM ${this.writesTable} ` +
				`WHERE thread_id = $tid AND checkpoint_ns = $ns AND checkpoint_id = $cid ` +
				`ORDER BY task_id, idx ASC`,
			{
				tid: threadId,
				ns: checkpointNs,
				cid: row.checkpoint_id,
			},
		);

		const pendingWrites = await Promise.all(
			writes.map(async (w) => {
				const value = await this.serde.loadsTyped(
					w.type,
					toBytes(w.value),
				);
				return [w.task_id, w.channel, value] as [
					string,
					string,
					unknown,
				];
			}),
		);

		const parentConfig: RunnableConfig | undefined = row.parent_id
			? {
					configurable: {
						thread_id: threadId,
						checkpoint_ns: checkpointNs,
						checkpoint_id: row.parent_id,
					},
				}
			: undefined;

		return {
			config: {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: checkpointNs,
					checkpoint_id: row.checkpoint_id,
				},
			},
			checkpoint,
			metadata: row.metadata,
			pendingWrites,
			parentConfig,
		};
	}

	override async *list(
		config: RunnableConfig,
		options?: CheckpointListOptions,
	): AsyncGenerator<CheckpointTuple> {
		await this.setup();
		const threadId = String(config.configurable?.thread_id ?? '');
		const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
		const beforeId = options?.before?.configurable?.checkpoint_id as
			| string
			| undefined;
		const limit = options?.limit;

		const conditions: string[] = ['thread_id = $tid'];
		const bindings: Record<string, unknown> = {
			tid: threadId,
			ns: checkpointNs,
		};
		conditions.push('checkpoint_ns = $ns');
		if (beforeId) {
			conditions.push('checkpoint_id < $beforeId');
			bindings.beforeId = beforeId;
		}
		if (options?.filter) {
			let i = 0;
			for (const [key, value] of Object.entries(options.filter)) {
				const bind = `mfilter_${i++}`;
				conditions.push(`metadata.${key} = $${bind}`);
				bindings[bind] = value;
			}
		}
		const limitClause =
			typeof limit === 'number' ? ` LIMIT ${limit}` : '';

		const rows = await this.client.queryAll<CheckpointRow>(
			`SELECT * FROM ${this.checkpointsTable} ` +
				`WHERE ${conditions.join(' AND ')} ` +
				`ORDER BY checkpoint_id DESC${limitClause}`,
			bindings,
		);

		for (const row of rows) {
			const checkpoint = (await this.serde.loadsTyped(
				row.type,
				toBytes(row.checkpoint),
			)) as Checkpoint;
			if (
				typeof checkpoint.v === 'number' &&
				checkpoint.v < SUPPORTED_CHECKPOINT_VERSION
			) {
				continue;
			}
			yield {
				config: {
					configurable: {
						thread_id: threadId,
						checkpoint_ns: checkpointNs,
						checkpoint_id: row.checkpoint_id,
					},
				},
				checkpoint,
				metadata: row.metadata,
				parentConfig: row.parent_id
					? {
							configurable: {
								thread_id: threadId,
								checkpoint_ns: checkpointNs,
								checkpoint_id: row.parent_id,
							},
						}
					: undefined,
			};
		}
	}

	override async put(
		config: RunnableConfig,
		checkpoint: Checkpoint,
		metadata: CheckpointMetadata,
		_newVersions: ChannelVersions,
	): Promise<RunnableConfig> {
		await this.setup();
		const threadId = String(config.configurable?.thread_id ?? '');
		if (!threadId) {
			throw new Error(
				'CheckpointSaver.put requires config.configurable.thread_id',
			);
		}
		const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
		const parentId = config.configurable?.checkpoint_id as
			| string
			| undefined;

		const [type, bytes] = await this.serde.dumpsTyped(checkpoint);

		await this.client.execute(
			`UPSERT ${this.checkpointsTable} ` +
				`MERGE { ` +
				`thread_id: $tid, ` +
				`checkpoint_ns: $ns, ` +
				`checkpoint_id: $cid, ` +
				`parent_id: $parent, ` +
				`type: $type, ` +
				`checkpoint: $bytes, ` +
				`metadata: $metadata, ` +
				`created_at: time::now() ` +
				`} ` +
				`WHERE thread_id = $tid AND checkpoint_ns = $ns AND checkpoint_id = $cid`,
			{
				tid: threadId,
				ns: checkpointNs,
				cid: checkpoint.id,
				parent: parentId ?? null,
				type,
				bytes,
				metadata,
			},
		);

		return {
			configurable: {
				thread_id: threadId,
				checkpoint_ns: checkpointNs,
				checkpoint_id: checkpoint.id,
			},
		};
	}

	override async putWrites(
		config: RunnableConfig,
		writes: PendingWrite[],
		taskId: string,
	): Promise<void> {
		await this.setup();
		const threadId = String(config.configurable?.thread_id ?? '');
		const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
		const checkpointId = String(
			config.configurable?.checkpoint_id ?? '',
		);
		if (!threadId || !checkpointId) {
			throw new Error(
				'CheckpointSaver.putWrites requires thread_id and checkpoint_id in configurable',
			);
		}

		const rows: CheckpointWriteRow[] = await Promise.all(
			writes.map(async ([channel, value], i) => {
				const [type, bytes] = await this.serde.dumpsTyped(value);
				const idx = WRITES_IDX_MAP[channel] ?? i;
				return {
					thread_id: threadId,
					checkpoint_ns: checkpointNs,
					checkpoint_id: checkpointId,
					task_id: taskId,
					idx,
					channel,
					type,
					value: bytes,
				};
			}),
		);

		await this.client.tx(async (db) => {
			for (const row of rows) {
				const isSpecial = row.channel in WRITES_IDX_MAP;
				if (isSpecial) {
					// Insert-only-if-absent: skip when a row at the same key exists.
					const existing = await db.query<[unknown[]]>(
						`SELECT id FROM ${this.writesTable} ` +
							`WHERE thread_id = $tid AND checkpoint_ns = $ns ` +
							`AND checkpoint_id = $cid AND task_id = $task AND idx = $idx`,
						{
							tid: row.thread_id,
							ns: row.checkpoint_ns,
							cid: row.checkpoint_id,
							task: row.task_id,
							idx: row.idx,
						},
					);
					if ((existing[0] as unknown[])?.length) continue;
					await db.query(
						`CREATE ${this.writesTable} CONTENT $row`,
						{ row },
					);
				} else {
					await db.query(
						`UPSERT ${this.writesTable} MERGE $row ` +
							`WHERE thread_id = $tid AND checkpoint_ns = $ns ` +
							`AND checkpoint_id = $cid AND task_id = $task AND idx = $idx`,
						{
							row,
							tid: row.thread_id,
							ns: row.checkpoint_ns,
							cid: row.checkpoint_id,
							task: row.task_id,
							idx: row.idx,
						},
					);
				}
			}
		});
	}

	override async deleteThread(threadId: string): Promise<void> {
		await this.setup();
		await this.client.tx(async (db) => {
			await db.query(
				`DELETE FROM ${this.checkpointsTable} WHERE thread_id = $tid`,
				{ tid: threadId },
			);
			await db.query(
				`DELETE FROM ${this.writesTable} WHERE thread_id = $tid`,
				{ tid: threadId },
			);
		});
	}
}

function toBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return new Uint8Array(value as number[]);
	if (typeof value === 'string') return new TextEncoder().encode(value);
	if (
		typeof value === 'object' &&
		value !== null &&
		'buffer' in (value as object)
	) {
		return new Uint8Array((value as { buffer: ArrayBufferLike }).buffer);
	}
	throw new Error('Unable to coerce checkpoint payload to Uint8Array');
}
