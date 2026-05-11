import {
	BaseStore as BaseLangGraphStore,
	type GetOperation,
	type IndexConfig,
	type Item,
	type ListNamespacesOperation,
	type MatchCondition,
	type Operation,
	type OperationResults,
	type PutOperation,
	type SearchItem,
	type SearchOperation,
	getTextAtPath,
} from '@langchain/langgraph-checkpoint';
import {
	assertIdent,
	defineTable,
	defineVectorIndex,
	type DistanceStrategy,
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const STORE_TABLE = 'langgraph_store';

export interface StoreArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	/** Optional vector search configuration. */
	index?: IndexConfig & {
		distanceStrategy?: DistanceStrategy;
	};
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
 * `search`, `delete` and `listNamespaces` on top of it. All operations
 * in a single `batch` call are executed inside one SurrealQL
 * transaction, preserving input order on the result side.
 */
export class Store extends BaseLangGraphStore {
	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly index?: StoreArgs['index'];
	readonly distanceStrategy: DistanceStrategy;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: StoreArgs) {
		super();
		this.tableName = assertIdent(args.tableName ?? STORE_TABLE, 'table');
		this.index = args.index;
		this.distanceStrategy = args.index?.distanceStrategy ?? 'cosine';
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
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_pk ON ${this.tableName} ` +
					`FIELDS namespace, key UNIQUE;`,
			);
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
					type: 'hnsw',
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
		const results: unknown[] = new Array(operations.length);

		await this.client.tx(async () => {
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
		});

		return results as OperationResults<Op>;
	}

	private async runGet(op: GetOperation): Promise<Item | null> {
		const row = await this.client.queryOne<StoreRow>(
			`SELECT * FROM ${this.tableName} WHERE namespace = $ns AND key = $key`,
			{ ns: op.namespace, key: op.key },
		);
		return row ? rowToItem(row) : null;
	}

	private async runPut(op: PutOperation): Promise<void> {
		if (op.value === null) {
			await this.client.execute(
				`DELETE FROM ${this.tableName} WHERE namespace = $ns AND key = $key`,
				{ ns: op.namespace, key: op.key },
			);
			return;
		}

		let embedding: number[] | undefined;
		if (this.index && op.index !== false) {
			const fields = (op.index as string[] | undefined) ??
				this.index.fields ?? ['$'];
			const texts = extractTexts(op.value, fields);
			if (texts.length > 0) {
				const vectors = await this.index.embeddings.embedDocuments(
					texts,
				);
				embedding = averageVectors(vectors);
			}
		}

		await this.client.execute(
			`UPSERT ${this.tableName} ` +
				`MERGE { namespace: $ns, key: $key, value: $value, ` +
				`updated_at: time::now()` +
				(embedding ? `, embedding: $embedding` : '') +
				` } ` +
				`WHERE namespace = $ns AND key = $key`,
			{
				ns: op.namespace,
				key: op.key,
				value: op.value,
				...(embedding ? { embedding } : {}),
			},
		);
	}

	private async runSearch(op: SearchOperation): Promise<SearchItem[]> {
		const limit = op.limit ?? 10;
		const offset = op.offset ?? 0;

		const conditions: string[] = [];
		const bindings: Record<string, unknown> = {};
		if (op.namespacePrefix.length > 0) {
			conditions.push(
				`namespace[..${op.namespacePrefix.length}] = $nsPrefix`,
			);
			bindings.nsPrefix = op.namespacePrefix;
		}
		if (op.filter) {
			let i = 0;
			for (const [key, value] of Object.entries(op.filter)) {
				const bind = `f${i++}`;
				if (value && typeof value === 'object' && !Array.isArray(value)) {
					for (const [opName, opValue] of Object.entries(
						value as Record<string, unknown>,
					)) {
						const opBind = `${bind}_${opName}`;
						conditions.push(
							`value.${key} ${cmpOp(opName)} $${opBind}`,
						);
						bindings[opBind] = opValue;
					}
				} else {
					conditions.push(`value.${key} = $${bind}`);
					bindings[bind] = value;
				}
			}
		}

		if (op.query && this.index) {
			const [vec] = await this.index.embeddings.embedDocuments([
				op.query,
			]);
			const baseWhere =
				conditions.length > 0 ? conditions.join(' AND ') + ' AND' : '';
			const surql =
				`SELECT *, vector::distance::knn() AS __score__ ` +
				`FROM ${this.tableName} ` +
				`WHERE ${baseWhere} embedding <|${limit + offset}|> $vec ` +
				`ORDER BY __score__ ASC LIMIT ${limit} START ${offset}`;
			const rows = await this.client.queryAll<
				StoreRow & { __score__: number }
			>(surql, { ...bindings, vec });
			return rows.map((row) => ({
				...rowToItem(row),
				score: 1 - row.__score__,
			}));
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
		const rows = await this.client.queryAll<StoreRow>(
			`SELECT * FROM ${this.tableName} ${where} ` +
				`ORDER BY created_at DESC LIMIT ${limit} START ${offset}`,
			bindings,
		);
		return rows.map((row) => ({ ...rowToItem(row) }));
	}

	private async runListNamespaces(
		op: ListNamespacesOperation,
	): Promise<string[][]> {
		const rows = await this.client.queryAll<{ namespace: string[] }>(
			`SELECT namespace FROM ${this.tableName}`,
		);
		let namespaces = rows.map((r) => r.namespace);
		if (op.matchConditions && op.matchConditions.length > 0) {
			const conditions = op.matchConditions;
			namespaces = namespaces.filter((ns) =>
				conditions.every((c) => matchesCondition(c, ns)),
			);
		}
		if (op.maxDepth !== undefined) {
			const seen = new Set<string>();
			const truncated: string[][] = [];
			for (const ns of namespaces) {
				const trimmed = ns.slice(0, op.maxDepth);
				const key = trimmed.join(' ');
				if (!seen.has(key)) {
					seen.add(key);
					truncated.push(trimmed);
				}
			}
			namespaces = truncated;
		}
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
			(p, i) =>
				p === '*' || key[key.length - path.length + i] === p,
		);
	}
	throw new Error(`Unsupported match type: ${matchType}`);
}

function cmpOp(op: string): string {
	switch (op) {
		case '$eq':
			return '=';
		case '$ne':
			return '!=';
		case '$gt':
			return '>';
		case '$gte':
			return '>=';
		case '$lt':
			return '<';
		case '$lte':
			return '<=';
		default:
			throw new Error(`Unsupported filter operator: ${op}`);
	}
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
