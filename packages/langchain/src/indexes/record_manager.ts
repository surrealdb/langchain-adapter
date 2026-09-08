import {
	type ListKeyOptions,
	RecordManager,
	type UpdateOptions,
} from '@langchain/core/indexing';
import {
	assertCount,
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const RECORD_MANAGER_TABLE = 'langchain_record_manager';

export interface SurrealDBRecordManagerArgs {
	/** Either an existing client, or the config to build one. */
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	/**
	 * Namespace for this index. Several indexes can share one table; every
	 * query is scoped to the namespace, mirroring `PostgresRecordManager`.
	 */
	namespace: string;
	tableName?: string;
	/** Skip `DEFINE TABLE` / `DEFINE INDEX` (an external migration owns it). */
	skipInitSchema?: boolean;
	/** Skip the SurrealDB v3 server version check. */
	skipVersionCheck?: boolean;
}

interface RecordRow {
	key: string;
	group_id: string | null;
	updated_at: number;
}

/**
 * SurrealDB-backed {@link RecordManager} for the LangChain indexing API.
 *
 * Paired with a vector store, `index()` uses this to keep a destination in
 * sync with a source: it records a content hash per document so unchanged
 * documents are skipped and removed ones are deleted.
 *
 * ```ts
 * await index({
 *   docsSource: docs,
 *   recordManager: await SurrealDBRecordManager.initialize({
 *     surreal, namespace: 'handbook',
 *   }),
 *   vectorStore,
 *   cleanup: 'incremental',
 *   sourceIdKey: 'source',
 * });
 * ```
 */
export class SurrealDBRecordManager extends RecordManager {
	override lc_namespace = ['langchain', 'recordmanagers', 'surrealdb'];

	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly namespace: string;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBRecordManagerArgs) {
		super();
		this.tableName = assertIdent(
			args.tableName ?? RECORD_MANAGER_TABLE,
			'table',
		);
		this.namespace = args.namespace;
		this.skipInitSchema = args.skipInitSchema ?? false;
		this.skipVersionCheck = args.skipVersionCheck ?? false;
		const { client, owned } = resolveClient(args.surreal);
		this.client = client;
		this.ownsClient = owned;
	}

	/** Construct + create the schema in one call. The recommended factory. */
	static async initialize(
		args: SurrealDBRecordManagerArgs,
	): Promise<SurrealDBRecordManager> {
		const manager = new SurrealDBRecordManager(args);
		await manager.createSchema();
		return manager;
	}

	override async createSchema(): Promise<void> {
		if (this.setupDone) return;
		await this.client.connect();
		if (!this.skipVersionCheck) await this.client.assertServerVersion();
		if (!this.skipInitSchema) {
			await this.client.execute(
				defineTable(this.tableName, [
					{ name: 'namespace', type: 'TYPE string' },
					{ name: 'key', type: 'TYPE string' },
					{ name: 'group_id', type: 'TYPE option<string>' },
					{ name: 'updated_at', type: 'TYPE int' },
				]),
			);
			await this.client.execute(
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_ns_updated_idx ` +
					`ON ${this.tableName} FIELDS namespace, updated_at;`,
			);
			await this.client.execute(
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_ns_group_idx ` +
					`ON ${this.tableName} FIELDS namespace, group_id;`,
			);
		}
		this.setupDone = true;
	}

	/**
	 * Server time, in epoch **microseconds**.
	 *
	 * Deliberately not `Date.now()`: `index()` compares timestamps written by
	 * possibly-concurrent indexers, and they only agree if the clock is the
	 * database's.
	 *
	 * Microseconds rather than milliseconds because `cleanup: 'full'` deletes
	 * keys whose `updated_at` is strictly *before* the run's start time. Two
	 * `index()` runs inside the same millisecond would otherwise carry equal
	 * timestamps and clean up nothing. The unit is opaque to `index()` — only
	 * internal consistency matters — and epoch micros stays a safe integer
	 * for another two centuries.
	 */
	override async getTime(): Promise<number> {
		await this.createSchema();
		// `queryMany`, not `queryAll`: a bare RETURN yields a scalar, not a
		// row array, so `queryAll` would hand back the number itself and
		// indexing into it gives undefined.
		const [now] = await this.client.queryMany<[number]>(
			`RETURN time::micros(time::now())`,
		);
		if (typeof now !== 'number') {
			throw new Error(
				`SurrealDBRecordManager.getTime: expected a number from the server, got ${typeof now}`,
			);
		}
		return now;
	}

	override async update(
		keys: string[],
		updateOptions: UpdateOptions = {},
	): Promise<void> {
		if (keys.length === 0) return;
		await this.createSchema();

		const { groupIds, timeAtLeast } = updateOptions;
		if (groupIds && groupIds.length !== keys.length) {
			throw new Error(
				`SurrealDBRecordManager.update: groupIds length (${groupIds.length}) ` +
					`does not match keys length (${keys.length})`,
			);
		}

		const updatedAt = await this.getTime();
		if (timeAtLeast !== undefined && updatedAt < timeAtLeast) {
			// The server clock is behind the caller's expectation; proceeding
			// would write timestamps that make already-indexed documents look
			// stale on the next run.
			throw new Error(
				`SurrealDBRecordManager.update: server time (${updatedAt}) is behind ` +
					`the requested timeAtLeast (${timeAtLeast}). Check for clock skew.`,
			);
		}

		const rows = keys.map((key, i) =>
			// `compactRow`, because `group_id` is `option<string>` and
			// SurrealDB rejects an explicit NULL there.
			compactRow({
				id: [this.namespace, key],
				namespace: this.namespace,
				key,
				group_id: groupIds?.[i],
				updated_at: updatedAt,
			}),
		);

		for (const chunk of batched(rows, 500)) {
			await this.client.execute(
				`INSERT INTO ${this.tableName} $rows ` +
					`ON DUPLICATE KEY UPDATE ` +
					`updated_at = $input.updated_at, group_id = $input.group_id`,
				{ rows: chunk },
			);
		}
	}

	override async exists(keys: string[]): Promise<boolean[]> {
		if (keys.length === 0) return [];
		await this.createSchema();
		const found = new Set(
			await this.client.queryAll<string>(
				`SELECT VALUE key FROM type::table($table) ` +
					`WHERE namespace = $ns AND key INSIDE $keys`,
				{ table: this.tableName, ns: this.namespace, keys },
			),
		);
		// Input order is the contract: `index()` zips this against its keys.
		return keys.map((key) => found.has(key));
	}

	override async listKeys(options: ListKeyOptions = {}): Promise<string[]> {
		await this.createSchema();
		const { before, after, groupIds, limit } = options;

		const conditions = ['namespace = $ns'];
		const bindings: Record<string, unknown> = {
			table: this.tableName,
			ns: this.namespace,
		};
		if (before !== undefined) {
			conditions.push('updated_at < $before');
			bindings.before = before;
		}
		if (after !== undefined) {
			conditions.push('updated_at > $after');
			bindings.after = after;
		}
		if (groupIds) {
			// `INSIDE` never matches NONE, so a null in groupIds has to become
			// its own disjunct or those rows are silently dropped.
			const present = groupIds.filter(
				(g): g is string => g !== null && g !== undefined,
			);
			const parts: string[] = [];
			if (present.length > 0) {
				parts.push('group_id INSIDE $groupIds');
				bindings.groupIds = present;
			}
			if (present.length !== groupIds.length) {
				parts.push('group_id IS NONE');
			}
			// An empty groupIds list matches nothing, which is what it means.
			conditions.push(parts.length > 0 ? `(${parts.join(' OR ')})` : 'false');
		}

		const limitClause =
			limit !== undefined ? ` LIMIT ${assertCount(limit)}` : '';
		return this.client.queryAll<string>(
			`SELECT VALUE key FROM type::table($table) ` +
				`WHERE ${conditions.join(' AND ')}` +
				`${limitClause}`,
			bindings,
		);
	}

	override async deleteKeys(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		await this.createSchema();
		for (const chunk of batched(keys, 500)) {
			await this.client.execute(
				`DELETE FROM type::table($table) ` +
					`WHERE namespace = $ns AND key INSIDE $keys`,
				{ table: this.tableName, ns: this.namespace, keys: chunk },
			);
		}
	}

	/** Drop the connection if this manager owns it. */
	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}
}

function* batched<T>(items: T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) {
		yield items.slice(i, i + size);
	}
}

export type { ListKeyOptions, UpdateOptions, RecordRow };
