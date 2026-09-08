import {
	BaseStore as BaseLangGraphStore,
	type GetOperation,
	getTextAtPath,
	type IndexConfig,
	type Item,
	type ListNamespacesOperation,
	type MatchCondition,
	type Operation,
	type OperationResults,
	type PutOperation,
	type SearchItem,
	type SearchOperation,
} from '@langchain/langgraph-checkpoint';
import {
	assertCount,
	assertIdent,
	type DistanceStrategy,
	defineTable,
	defineVectorIndex,
	knnPredicate,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	translateFilter,
	type VectorIndexType,
} from '@surrealdb/langchain-core';

const STORE_TABLE = 'langgraph_store';

export interface SurrealDBStoreArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	/** Optional vector search configuration. */
	index?: IndexConfig & {
		distanceStrategy?: DistanceStrategy;
	};
	/** Vector index to define on `embedding`. Default `'hnsw'`. */
	indexType?: VectorIndexType;
	/** Search breadth for the graph index. Default 40. */
	ef?: number;
	/**
	 * Throw when `search({ query })` is called without an `index` configured,
	 * instead of warning once and returning unranked rows. Default `false`.
	 */
	strictSearch?: boolean;
	skipInitSchema?: boolean;
	skipVersionCheck?: boolean;
}

interface StoreRow {
	id: { tb: string; id: string } | string;
	namespace: string[];
	key: string;
	value: Record<string, unknown>;
	created_at: string | Date;
	updated_at: string | Date;
	embedding?: number[] | null;
}

/**
 * SurrealDB-backed `BaseStore` for LangGraph.js long-term memory.
 *
 * Implements only `batch` — the base class wires `get`, `put`,
 * `search`, `delete` and `listNamespaces` on top of it. Operations run
 * sequentially as independent RPCs, preserving input order on the result
 * side; they are deliberately *not* wrapped in one transaction, because
 * `runPut` awaits the embedding provider and a transaction would hold a
 * SurrealDB write lock open across that network call.
 */
export class SurrealDBStore extends BaseLangGraphStore {
	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly index?: SurrealDBStoreArgs['index'];
	readonly indexType: VectorIndexType;
	readonly ef: number;
	readonly strictSearch: boolean;
	private warnedUnindexed = false;
	readonly distanceStrategy: DistanceStrategy;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBStoreArgs) {
		super();
		this.tableName = assertIdent(args.tableName ?? STORE_TABLE, 'table');
		this.index = args.index;
		this.distanceStrategy = args.index?.distanceStrategy ?? 'cosine';
		this.indexType = args.indexType ?? 'hnsw';
		this.ef = args.ef ?? 40;
		this.strictSearch = args.strictSearch ?? false;
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

	override async start(): Promise<void> {
		await this.setup();
	}

	override async stop(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	async setup(): Promise<void> {
		if (this.setupDone) return;
		await this.client.connect();
		if (!this.skipVersionCheck) {
			await this.client.assertServerVersion();
		}
		if (!this.skipInitSchema) {
			const fields = [
				{ name: 'namespace', type: 'TYPE array<string>' },
				{ name: 'key', type: 'TYPE string' },
				{ name: 'value', type: 'TYPE object FLEXIBLE' },
				{
					name: 'created_at',
					type: 'TYPE datetime DEFAULT time::now()',
				},
				{
					name: 'updated_at',
					type: 'TYPE datetime DEFAULT time::now() VALUE time::now()',
				},
			];
			if (this.index) {
				fields.push({
					name: 'embedding',
					type: 'TYPE option<array<float>>',
				});
			}
			await this.client.execute(defineTable(this.tableName, fields));

			await this.client.execute(
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_ns ON ${this.tableName} ` +
					`FIELDS namespace;`,
			);
			if (this.index) {
				const ddl = defineVectorIndex({
					tableName: this.tableName,
					indexName: `${this.tableName}_embedding_idx`,
					field: 'embedding',
					dimensions: this.index.dims,
					distance: this.distanceStrategy,
					type: this.indexType,
				});
				if (ddl) await this.client.execute(ddl);
			}
		}
		this.setupDone = true;
	}

	override async batch<Op extends Operation[]>(
		operations: Op,
	): Promise<OperationResults<Op>> {
		await this.setup();
		// Sequential, independent RPCs — see the class docblock for why this
		// is not one transaction.
		const results: unknown[] = new Array(operations.length);
		for (let i = 0; i < operations.length; i++) {
			const op = operations[i] as Operation;
			if ('value' in op) {
				results[i] = await this.runPut(op as PutOperation);
			} else if ('namespacePrefix' in op) {
				results[i] = await this.runSearch(op as SearchOperation);
			} else if ('key' in op) {
				results[i] = await this.runGet(op as GetOperation);
			} else {
				results[i] = await this.runListNamespaces(
					op as ListNamespacesOperation,
				);
			}
		}
		return results as OperationResults<Op>;
	}

	private async runGet(op: GetOperation): Promise<Item | null> {
		const row = await this.client.queryOne<StoreRow>(
			`SELECT * FROM type::record($table, [$ns, $key])`,
			{ table: this.tableName, ns: op.namespace, key: op.key },
		);
		return row ? rowToItem(row) : null;
	}

	private async runPut(op: PutOperation): Promise<void> {
		if (op.value === null) {
			await this.client.execute(
				`DELETE FROM type::record($table, [$ns, $key])`,
				{ table: this.tableName, ns: op.namespace, key: op.key },
			);
			return;
		}

		let embedding: number[] | undefined;
		if (this.index && op.index !== false) {
			const fields = (op.index as string[] | undefined) ??
				this.index.fields ?? ['$'];
			const texts = extractTexts(op.value, fields);
			if (texts.length > 0) {
				const vectors =
					await this.index.embeddings.embedDocuments(texts);
				embedding = averageVectors(vectors);
			}
		}

		await this.client.execute(
			`UPSERT type::record($table, [$ns, $key]) CONTENT $row`,
			{
				table: this.tableName,
				ns: op.namespace,
				key: op.key,
				row: {
					namespace: op.namespace,
					key: op.key,
					value: op.value,
					...(embedding ? { embedding } : {}),
				},
			},
		);
	}

	private async runSearch(op: SearchOperation): Promise<SearchItem[]> {
		const limit = op.limit ?? 10;
		const offset = op.offset ?? 0;

		const conditions: string[] = [];
		const bindings: Record<string, unknown> = { table: this.tableName };
		if (op.namespacePrefix.length > 0) {
			conditions.push(
				`namespace[..${op.namespacePrefix.length}] = $nsPrefix`,
			);
			bindings.nsPrefix = op.namespacePrefix;
		}
		if (op.filter) {
			// Shared with the vector store and the checkpointer, so filter
			// keys are escaped in one place — and `$in` / `$nin` / `$exists`
			// come along for free, where the hand-rolled loop threw.
			const { expr, bindings: filterBindings } = translateFilter(
				op.filter,
				{ fieldPrefix: 'value' },
			);
			if (expr) {
				conditions.push(expr);
				Object.assign(bindings, filterBindings);
			}
		}

		if (op.query && this.index) {
			// `embedQuery`, not `embedDocuments`: asymmetric embedding models
			// encode queries differently from stored text.
			const vec = await this.index.embeddings.embedQuery(op.query);
			// The KNN operator applies its own k, and SurrealDB allows only
			// one per query, so paging happens client-side over k+offset.
			const { predicate, distanceExpr } = knnPredicate({
				field: 'embedding',
				k: assertCount(limit + offset, 'limit'),
				distance: this.distanceStrategy,
				indexType: this.indexType,
				ef: this.ef,
			});
			const all = [predicate, ...conditions].join(' AND ');
			const surql =
				`SELECT *, ${distanceExpr} AS __score__ ` +
				`FROM type::table($table) ` +
				`WHERE ${all} ` +
				`ORDER BY __score__ ASC`;
			const rows = await this.client.queryAll<
				StoreRow & { __score__: number }
			>(surql, { ...bindings, vec });
			return rows.slice(offset, offset + limit).map((row) => ({
				...rowToItem(row),
				score: 1 - row.__score__,
			}));
		}

		if (op.query && !this.index) {
			// A semantic query with nothing to search semantically. Falling
			// through to a created_at scan would return plausible-looking but
			// unranked rows, so say so once rather than quietly misleading.
			if (this.strictSearch) {
				throw new Error(
					'SurrealDBStore.search was given a `query` but no `index` ' +
						'is configured, so there is nothing to search ' +
						'semantically. Configure `index`, or drop the query.',
				);
			}
			this.warnUnindexedQuery();
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
		const rows = await this.client.queryAll<StoreRow>(
			`SELECT * FROM type::table($table) ${where} ` +
				`ORDER BY created_at DESC ` +
				`LIMIT ${assertCount(limit)} START ${assertCount(offset, 'offset')}`,
			bindings,
		);
		return rows.map((row) => ({ ...rowToItem(row) }));
	}

	private warnUnindexedQuery(): void {
		if (this.warnedUnindexed) return;
		this.warnedUnindexed = true;
		console.warn(
			'[SurrealDBStore] search() received a `query` but no `index` is ' +
				'configured — returning recent items, unranked and without ' +
				'scores. Configure `index` for semantic search, or set ' +
				'`strictSearch: true` to make this an error.',
		);
	}

	private async runListNamespaces(
		op: ListNamespacesOperation,
	): Promise<string[][]> {
		const rows = await this.client.queryAll<{ namespace: string[] }>(
			`SELECT namespace FROM type::table($table)`,
			{ table: this.tableName },
		);
		let namespaces = rows.map((r) => r.namespace);
		if (op.matchConditions && op.matchConditions.length > 0) {
			const conditions = op.matchConditions;
			namespaces = namespaces.filter((ns) =>
				conditions.every((c) => matchesCondition(c, ns)),
			);
		}
		// One row per *item*, so a namespace repeats once per key it holds.
		// Dedupe always, not only when `maxDepth` trims, otherwise
		// `listNamespaces({ prefix })` returns the same namespace N times.
		const seen = new Set<string>();
		const unique: string[][] = [];
		for (const ns of namespaces) {
			const trimmed =
				op.maxDepth !== undefined ? ns.slice(0, op.maxDepth) : ns;
			const key = JSON.stringify(trimmed);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(trimmed);
			}
		}
		namespaces = unique;
		namespaces.sort((a, b) => a.join(':').localeCompare(b.join(':')));
		const start = op.offset ?? 0;
		const end = start + (op.limit ?? namespaces.length);
		return namespaces.slice(start, end);
	}
}

function rowToItem(row: StoreRow): Item {
	return {
		namespace: row.namespace,
		key: row.key,
		value: row.value,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}

function matchesCondition(c: MatchCondition, key: string[]): boolean {
	const { matchType, path } = c;
	if (path.length > key.length) return false;
	if (matchType === 'prefix') {
		return path.every((p, i) => p === '*' || key[i] === p);
	}
	if (matchType === 'suffix') {
		return path.every(
			(p, i) => p === '*' || key[key.length - path.length + i] === p,
		);
	}
	throw new Error(`Unsupported match type: ${matchType}`);
}


function extractTexts(
	value: Record<string, unknown>,
	fields: string[],
): string[] {
	const out: string[] = [];
	for (const field of fields) {
		if (field === '$') {
			out.push(JSON.stringify(value));
			continue;
		}
		out.push(...getTextAtPath(value, field));
	}
	return out.filter((t) => t.length > 0);
}

function averageVectors(vectors: number[][]): number[] {
	if (vectors.length === 0) return [];
	const len = (vectors[0] as number[]).length;
	const sum = new Array<number>(len).fill(0);
	for (const v of vectors) {
		for (let i = 0; i < len; i++) {
			sum[i] = (sum[i] ?? 0) + ((v[i] as number) ?? 0);
		}
	}
	return sum.map((s) => s / vectors.length);
}
