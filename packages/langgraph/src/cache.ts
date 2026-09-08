import {
	BaseCache as BaseLangGraphCache,
	type CacheFullKey,
	type CacheNamespace,
	type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import {
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
	toBytes,
	toRecordId,
} from '@surrealdb/langchain-core';

const CACHE_TABLE = 'langgraph_cache';

export interface SurrealDBNodeCacheArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	serde?: SerializerProtocol;
	/**
	 * Called when a write fails. The pregel loop calls `set()` without
	 * awaiting it, so a rejection there becomes an unhandled rejection rather
	 * than something the graph can catch — the cache swallows write errors and
	 * reports them here instead. Defaults to a console warning.
	 */
	onError?: (err: unknown) => void;
	skipInitSchema?: boolean;
	skipVersionCheck?: boolean;
}

interface CacheRow {
	ns: string[];
	key: string;
	enc: string;
	val: unknown;
}

/**
 * SurrealDB-backed node cache for LangGraph.js.
 *
 * ```ts
 * const graph = builder.compile({
 *   cache: new SurrealDBNodeCache({ surreal }),
 * });
 * builder.addNode('expensive', fn, { cachePolicy: { ttl: 120 } });
 * ```
 */
export class SurrealDBNodeCache<V = unknown> extends BaseLangGraphCache<V> {
	readonly client: SurrealDBClient;
	readonly tableName: string;
	private readonly onError: (err: unknown) => void;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBNodeCacheArgs) {
		super(args.serde);
		this.tableName = assertIdent(args.tableName ?? CACHE_TABLE, 'table');
		this.onError =
			args.onError ??
			((err) => {
				console.warn('[SurrealDBNodeCache] write failed:', err);
			});
		this.skipInitSchema = args.skipInitSchema ?? false;
		this.skipVersionCheck = args.skipVersionCheck ?? false;
		const { client, owned } = resolveClient(args.surreal);
		this.client = client;
		this.ownsClient = owned;
	}

	private async setup(): Promise<void> {
		if (this.setupDone) return;
		await this.client.connect();
		if (!this.skipVersionCheck) await this.client.assertServerVersion();
		if (!this.skipInitSchema) {
			await this.client.execute(
				defineTable(this.tableName, [
					{ name: 'ns', type: 'TYPE array<string>' },
					{ name: 'key', type: 'TYPE string' },
					{ name: 'enc', type: 'TYPE string' },
					{ name: 'val', type: 'TYPE bytes' },
					{
						name: 'created_at',
						type: 'TYPE datetime DEFAULT time::now()',
					},
					{ name: 'expires_at', type: 'TYPE option<datetime>' },
				]),
			);
		}
		this.setupDone = true;
	}

	// An array record id, never a joined string: the namespace contains
	// user-chosen node names.
	private id(ns: CacheNamespace, key: string) {
		return toRecordId(this.tableName, [ns, key]);
	}

	override async get(
		keys: CacheFullKey[],
	): Promise<{ key: CacheFullKey; value: V }[]> {
		if (keys.length === 0) return [];
		await this.setup();

		const rows = await this.client.queryAll<CacheRow>(
			`SELECT ns, key, enc, val FROM $ids ` +
				`WHERE expires_at IS NONE OR expires_at > time::now()`,
			{ ids: keys.map(([ns, key]) => this.id(ns, key)) },
		);

		// Return the caller's own tuples: the pregel loop re-serialises the
		// key it gets back to find the task it belongs to, so a structurally
		// equal but differently-built tuple would miss.
		const byKey = new Map<string, CacheFullKey>(
			keys.map((k) => [JSON.stringify(k), k]),
		);

		const out: { key: CacheFullKey; value: V }[] = [];
		for (const row of rows) {
			const original = byKey.get(JSON.stringify([row.ns, row.key]));
			if (!original) continue; // misses are omitted, never returned as null
			out.push({
				key: original,
				value: (await this.serde.loadsTyped(
					row.enc,
					toBytes(row.val, 'cache value'),
				)) as V,
			});
		}
		return out;
	}

	override async set(
		pairs: { key: CacheFullKey; value: V; ttl?: number }[],
	): Promise<void> {
		if (pairs.length === 0) return;
		try {
			await this.setup();
			const rows = await Promise.all(
				pairs.map(async ({ key: [ns, key], value, ttl }) => {
					const [enc, val] = await this.serde.dumpsTyped(value);
					return compactRow({
						id: this.id(ns, key),
						ns,
						key,
						enc,
						val,
						// `ttl` is seconds, per the CachePolicy contract.
						expires_at:
							ttl === undefined
								? undefined
								: new Date(Date.now() + ttl * 1000),
					});
				}),
			);
			await this.client.execute(
				`INSERT INTO ${this.tableName} $rows ` +
					`ON DUPLICATE KEY UPDATE ` +
					`enc = $input.enc, val = $input.val, ` +
					`expires_at = $input.expires_at`,
				{ rows },
			);
		} catch (err) {
			// See `onError`: the caller does not await us.
			this.onError(err);
		}
	}

	override async clear(namespaces: CacheNamespace[]): Promise<void> {
		await this.setup();
		if (namespaces.length === 0) {
			// An empty list means "everything", per the BaseCache contract.
			await this.client.execute(`DELETE FROM type::table($table)`, {
				table: this.tableName,
			});
			return;
		}
		await this.client.tx(async (tx) => {
			for (const ns of namespaces) {
				await tx
					.query(
						`DELETE FROM type::table($table) WHERE ns = $ns`,
						{ table: this.tableName, ns },
					)
					.collect();
			}
		});
	}

	/** Delete entries whose TTL has elapsed. Expired rows are never served. */
	async sweepExpired(): Promise<void> {
		await this.setup();
		await this.client.execute(
			`DELETE FROM type::table($table) ` +
				`WHERE expires_at IS NOT NONE AND expires_at <= time::now()`,
			{ table: this.tableName },
		);
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}
}
