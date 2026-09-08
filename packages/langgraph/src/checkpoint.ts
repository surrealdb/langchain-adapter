import type { RunnableConfig } from '@langchain/core/runnables';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';
import {
	BaseCheckpointSaver as BaseLangGraphCheckpointSaver,
	type ChannelVersions,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointTuple,
	type PendingWrite,
	WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import {
	assertCount,
	assertIdent,
	defineTable,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	toBytes,
	translateFilter,
} from '@surrealdb/langchain-core';

const CHECKPOINTS_TABLE = 'langgraph_checkpoints';
const WRITES_TABLE = 'langgraph_checkpoint_writes';
const SUPPORTED_CHECKPOINT_VERSION = 4;

export interface SurrealDBSaverArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	serde?: SerializerProtocol;
	checkpointsTable?: string;
	writesTable?: string;
	/** Skip table/index creation (assume an external migration owns it). */
	skipInitSchema?: boolean;
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
export class SurrealDBSaver extends BaseLangGraphCheckpointSaver {
	readonly client: SurrealDBClient;
	readonly checkpointsTable: string;
	readonly writesTable: string;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBSaverArgs) {
		super(args.serde);
		// Both reach raw `DEFINE INDEX` DDL, which cannot bind parameters.
		this.checkpointsTable = assertIdent(
			args.checkpointsTable ?? CHECKPOINTS_TABLE,
			'checkpoints table',
		);
		this.writesTable = assertIdent(
			args.writesTable ?? WRITES_TABLE,
			'writes table',
		);
		this.skipInitSchema = args.skipInitSchema ?? false;
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

		if (!this.skipInitSchema) {
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
					{ name: 'metadata', type: 'TYPE object FLEXIBLE DEFAULT {}' },
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
		}

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
					`SELECT * FROM type::record($table, [$tid, $ns, $cid])`,
					{
						table: this.checkpointsTable,
						tid: threadId,
						ns: checkpointNs,
						cid: checkpointId,
					},
				)
			: await this.client.queryOne<CheckpointRow>(
					`SELECT * FROM type::table($table) ` +
						`WHERE thread_id = $tid AND checkpoint_ns = $ns ` +
						`ORDER BY checkpoint_id DESC LIMIT 1`,
					{
						table: this.checkpointsTable,
						tid: threadId,
						ns: checkpointNs,
					},
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
			throw new Error(unsupportedVersionMessage(checkpoint.v));
		}

		const writes = await this.client.queryAll<CheckpointWriteRow>(
			`SELECT * FROM type::table($table) ` +
				`WHERE thread_id = $tid AND checkpoint_ns = $ns AND checkpoint_id = $cid ` +
				`ORDER BY task_id, idx ASC`,
			{
				table: this.writesTable,
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
		// `thread_id` is optional — omitting it lists across every thread,
		// matching MemorySaver. `checkpoint_ns` is filtered only when the
		// caller actually supplied one: coercing `undefined` to `''` pins
		// every query to the root namespace.
		const threadId = config.configurable?.thread_id as string | undefined;
		const checkpointNs = config.configurable?.checkpoint_ns as
			| string
			| undefined;
		const checkpointId = config.configurable?.checkpoint_id as
			| string
			| undefined;
		const beforeId = options?.before?.configurable?.checkpoint_id as
			| string
			| undefined;
		const limit = options?.limit;

		const conditions: string[] = [];
		const bindings: Record<string, unknown> = {
			table: this.checkpointsTable,
		};
		if (threadId !== undefined) {
			conditions.push('thread_id = $tid');
			bindings.tid = threadId;
		}
		if (checkpointNs !== undefined) {
			conditions.push('checkpoint_ns = $ns');
			bindings.ns = checkpointNs;
		}
		if (checkpointId !== undefined) {
			conditions.push('checkpoint_id = $cid');
			bindings.cid = checkpointId;
		}
		if (beforeId) {
			conditions.push('checkpoint_id < $beforeId');
			bindings.beforeId = beforeId;
		}
		if (options?.filter) {
			const { expr, bindings: filterBindings } = translateFilter(
				options.filter,
				{ fieldPrefix: 'metadata', bindPrefix: 'mfilter' },
			);
			if (expr) {
				conditions.push(expr);
				Object.assign(bindings, filterBindings);
			}
		}
		const whereClause =
			conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
		const limitClause =
			typeof limit === 'number' ? ` LIMIT ${assertCount(limit)}` : '';

		const rows = await this.client.queryAll<CheckpointRow>(
			`SELECT * FROM type::table($table) ` +
				`${whereClause}` +
				`ORDER BY thread_id ASC, checkpoint_ns ASC, checkpoint_id DESC` +
				`${limitClause}`,
			bindings,
		);
		if (rows.length === 0) return;

		// One batched query for every checkpoint's writes, bucketed in JS.
		// `getStateHistory()` reports no pending tasks without these.
		const pendingByCheckpoint = await this.loadPendingWrites(rows);

		for (const row of rows) {
			const checkpoint = (await this.serde.loadsTyped(
				row.type,
				toBytes(row.checkpoint),
			)) as Checkpoint;
			if (
				typeof checkpoint.v === 'number' &&
				checkpoint.v < SUPPORTED_CHECKPOINT_VERSION
			) {
				// Consistent with `getTuple`, which refuses rather than
				// silently skipping — an unreadable checkpoint should not
				// quietly vanish from a history listing.
				throw new Error(unsupportedVersionMessage(checkpoint.v));
			}
			// Built from *this row's* thread/namespace, not the request's,
			// which may have named neither.
			const scope = {
				thread_id: row.thread_id,
				checkpoint_ns: row.checkpoint_ns,
			};
			yield {
				config: {
					configurable: {
						...scope,
						checkpoint_id: row.checkpoint_id,
					},
				},
				checkpoint,
				metadata: row.metadata,
				pendingWrites:
					pendingByCheckpoint.get(
						writeKey(
							row.thread_id,
							row.checkpoint_ns,
							row.checkpoint_id,
						),
					) ?? [],
				parentConfig: row.parent_id
					? {
							configurable: {
								...scope,
								checkpoint_id: row.parent_id,
							},
						}
					: undefined,
			};
		}
	}

	/** Pending writes for a page of checkpoints, in one round trip. */
	private async loadPendingWrites(
		rows: CheckpointRow[],
	): Promise<Map<string, [string, string, unknown][]>> {
		const writes = await this.client.queryAll<CheckpointWriteRow>(
			`SELECT * FROM type::table($table) ` +
				`WHERE thread_id INSIDE $tids AND checkpoint_ns INSIDE $nss ` +
				`AND checkpoint_id INSIDE $cids ` +
				`ORDER BY task_id, idx ASC`,
			{
				table: this.writesTable,
				tids: [...new Set(rows.map((r) => r.thread_id))],
				nss: [...new Set(rows.map((r) => r.checkpoint_ns))],
				cids: [...new Set(rows.map((r) => r.checkpoint_id))],
			},
		);

		const byCheckpoint = new Map<string, [string, string, unknown][]>();
		for (const w of writes) {
			const value = await this.serde.loadsTyped(w.type, toBytes(w.value));
			const key = writeKey(w.thread_id, w.checkpoint_ns, w.checkpoint_id);
			const bucket = byCheckpoint.get(key);
			const entry: [string, string, unknown] = [
				w.task_id,
				w.channel,
				value,
			];
			if (bucket) bucket.push(entry);
			else byCheckpoint.set(key, [entry]);
		}
		return byCheckpoint;
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
				'SurrealDBSaver.put requires config.configurable.thread_id',
			);
		}
		const checkpointNs = String(config.configurable?.checkpoint_ns ?? '');
		const parentId = config.configurable?.checkpoint_id as
			| string
			| undefined;

		const [type, bytes] = await this.serde.dumpsTyped(checkpoint);

		const row: Record<string, unknown> = {
			thread_id: threadId,
			checkpoint_ns: checkpointNs,
			checkpoint_id: checkpoint.id,
			type,
			checkpoint: bytes,
			metadata,
		};
		if (parentId !== undefined) row.parent_id = parentId;

		await this.client.execute(
			`UPSERT type::record($table, [$tid, $ns, $cid]) CONTENT $row`,
			{
				table: this.checkpointsTable,
				tid: threadId,
				ns: checkpointNs,
				cid: checkpoint.id,
				row,
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
		const checkpointId = String(config.configurable?.checkpoint_id ?? '');
		if (!threadId || !checkpointId) {
			throw new Error(
				'SurrealDBSaver.putWrites requires thread_id and checkpoint_id in configurable',
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

		await this.client.tx(async (tx) => {
			for (const row of rows) {
				// Conflict policy, matching `MemorySaver.putWrites`:
				//
				//   - Regular channels (idx >= 0) are insert-if-absent. A task
				//     replayed after a crash must not clobber the writes the
				//     first attempt already recorded.
				//   - The well-known channels (`__error__`, `__scheduled__`,
				//     `__interrupt__`, `__resume__`, all mapped to negative
				//     indices) overwrite, because their *latest* value is the
				//     meaningful one — an interrupt resumed twice must not keep
				//     the stale payload.
				//
				// This was previously inverted.
				const overwrites = row.idx < 0;
				const bindings = {
					table: this.writesTable,
					tid: row.thread_id,
					ns: row.checkpoint_ns,
					cid: row.checkpoint_id,
					task: row.task_id,
					idx: row.idx,
					row,
				};
				if (overwrites) {
					await tx
						.query(
							`UPSERT type::record($table, [$tid, $ns, $cid, $task, $idx]) CONTENT $row`,
							bindings,
						)
						.collect();
				} else {
					const existing = await tx
						.query<[unknown[]]>(
							`SELECT id FROM type::record($table, [$tid, $ns, $cid, $task, $idx])`,
							bindings,
						)
						.collect();
					const found = existing[0];
					if (Array.isArray(found) && found.length > 0) continue;
					await tx
						.query(
							`CREATE type::record($table, [$tid, $ns, $cid, $task, $idx]) CONTENT $row`,
							bindings,
						)
						.collect();
				}
			}
		});
	}

	override async deleteThread(threadId: string): Promise<void> {
		await this.setup();
		await this.client.tx(async (tx) => {
			await tx
				.query(
					`DELETE FROM type::table($table) WHERE thread_id = $tid`,
					{ table: this.checkpointsTable, tid: threadId },
				)
				.collect();
			await tx
				.query(
					`DELETE FROM type::table($table) WHERE thread_id = $tid`,
					{ table: this.writesTable, tid: threadId },
				)
				.collect();
		});
	}
}

function writeKey(threadId: string, ns: string, checkpointId: string): string {
	return JSON.stringify([threadId, ns, checkpointId]);
}

function unsupportedVersionMessage(version: number): string {
	return (
		`SurrealDBSaver: refusing to load Checkpoint v${version} ` +
		`(expected v${SUPPORTED_CHECKPOINT_VERSION}+). Migrate the checkpoint ` +
		`upstream (e.g. via @langchain/langgraph-checkpoint-postgres) ` +
		`before reading it back.`
	);
}
