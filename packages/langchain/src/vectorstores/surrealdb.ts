import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore as BaseVectorStore } from '@langchain/core/vectorstores';
import {
	assertIdent,
	type DistanceStrategy,
	defineTable,
	defineVectorIndex,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	translateFilter,
	type VectorIndexType,
} from '@surrealdb/langchain-core';

export type { DistanceStrategy, VectorIndexType };

export interface VectorStoreArgs {
	/** Either an existing client/config OR a fresh URL/token config. */
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	contentField?: string;
	metadataField?: string;
	vectorField?: string;
	idField?: string;
	dimensions: number;
	distanceStrategy?: DistanceStrategy;
	indexType?: VectorIndexType;
	hnswOptions?: { m?: number; efc?: number };
	mtreeOptions?: { capacity?: number };
	/** Skip schema/index creation (assume an external migration owns it). */
	skipInitSchema?: boolean;
	/** Skip the SurrealDB v3 server version check. */
	skipVersionCheck?: boolean;
}

interface DocumentRow {
	id: { tb: string; id: string } | string;
	[field: string]: unknown;
}

/**
 * SurrealDB-backed vector store for LangChain.js.
 *
 * Uses SurrealDB's native HNSW (or MTREE) vector index. Requires SurrealDB
 * server v3.x.
 *
 * Construct via {@link VectorStore.initialize} (or the static
 * {@link fromTexts}/{@link fromDocuments} factories) — the synchronous
 * constructor cannot perform the connection or schema setup.
 */
export class VectorStore extends BaseVectorStore {
	declare FilterType: Record<string, any>;

	override _vectorstoreType(): string {
		return 'surrealdb';
	}

	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly contentField: string;
	readonly metadataField: string;
	readonly vectorField: string;
	readonly idField: string;
	readonly dimensions: number;
	readonly distanceStrategy: DistanceStrategy;
	readonly indexType: VectorIndexType;
	readonly hnswOptions: { m?: number; efc?: number };
	readonly mtreeOptions: { capacity?: number };
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private initialised = false;

	constructor(embeddings: EmbeddingsInterface, args: VectorStoreArgs) {
		super(embeddings, args);

		this.tableName = assertIdent(args.tableName ?? 'documents', 'table');
		this.contentField = assertIdent(
			args.contentField ?? 'content',
			'field',
		);
		this.metadataField = assertIdent(
			args.metadataField ?? 'metadata',
			'field',
		);
		this.vectorField = assertIdent(
			args.vectorField ?? 'embedding',
			'field',
		);
		this.idField = assertIdent(args.idField ?? 'id', 'field');
		this.dimensions = args.dimensions;
		this.distanceStrategy = args.distanceStrategy ?? 'cosine';
		this.indexType = args.indexType ?? 'hnsw';
		this.hnswOptions = args.hnswOptions ?? {};
		this.mtreeOptions = args.mtreeOptions ?? {};
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

	override lc_namespace = ['langchain', 'vectorstores', 'surrealdb'];

	/**
	 * Connect, run the version check and create the table + vector index
	 * if necessary. Idempotent — safe to call repeatedly.
	 */
	async initialize(): Promise<void> {
		if (this.initialised) return;
		await this.client.connect();
		if (!this.skipVersionCheck) {
			await this.client.assertServerVersion();
		}
		if (!this.skipInitSchema) {
			await this.applySchema();
		}
		this.initialised = true;
	}

	/** Construct + initialise in one call. The recommended factory. */
	static async initialize(
		embeddings: EmbeddingsInterface,
		args: VectorStoreArgs,
	): Promise<VectorStore> {
		const store = new VectorStore(embeddings, args);
		await store.initialize();
		return store;
	}

	static override async fromTexts(
		texts: string[],
		metadatas: object[] | object,
		embeddings: EmbeddingsInterface,
		args: VectorStoreArgs,
	): Promise<VectorStore> {
		const docs = texts.map(
			(pageContent, i) =>
				new Document({
					pageContent,
					metadata: Array.isArray(metadatas)
						? (metadatas[i] ?? {})
						: metadatas,
				}),
		);
		return VectorStore.fromDocuments(docs, embeddings, args);
	}

	static override async fromDocuments(
		docs: DocumentInterface[],
		embeddings: EmbeddingsInterface,
		args: VectorStoreArgs,
	): Promise<VectorStore> {
		const store = await VectorStore.initialize(embeddings, args);
		await store.addDocuments(docs);
		return store;
	}

	/** Drop the connection if this store owns it. */
	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	override async addDocuments(
		documents: DocumentInterface[],
		options?: { ids?: string[] },
	): Promise<string[]> {
		await this.initialize();
		const texts = documents.map((d) => d.pageContent);
		const vectors = await this.embeddings.embedDocuments(texts);
		return this.addVectors(vectors, documents, options);
	}

	override async addVectors(
		vectors: number[][],
		documents: DocumentInterface[],
		options?: { ids?: string[] },
	): Promise<string[]> {
		await this.initialize();
		if (vectors.length !== documents.length) {
			throw new Error(
				`Vector count (${vectors.length}) does not match document count (${documents.length})`,
			);
		}
		if (vectors.length === 0) return [];

		const ids = options?.ids;
		if (ids && ids.length !== documents.length) {
			throw new Error(
				`ids length (${ids.length}) does not match documents length (${documents.length})`,
			);
		}

		const records = documents.map((doc, i) => {
			const record: Record<string, unknown> = {
				[this.contentField]: doc.pageContent,
				[this.metadataField]: doc.metadata ?? {},
				[this.vectorField]: vectors[i],
			};
			if (ids?.[i]) {
				record[this.idField] =
					`${this.tableName}:${escapeId(ids[i] as string)}`;
			}
			return record;
		});

		const inserted = await this.client.queryAll<DocumentRow>(
			`INSERT INTO ${this.tableName} $records`,
			{ records },
		);
		return inserted.map((row) => stringifyRecordId(row[this.idField]));
	}

	override async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: this['FilterType'],
	): Promise<[DocumentInterface, number][]> {
		await this.initialize();

		const { expr, bindings } = translateFilter(filter, {
			fieldPrefix: this.metadataField,
		});
		const distExpr = explicitDistance(
			this.distanceStrategy,
			this.vectorField,
		);

		// We deliberately do NOT use the `<|k|>` index operator here.
		// SurrealDB v3 rejects it when combined with extra WHERE
		// conditions ("KNN operators … mixed with unsupported KNN
		// variants"). Brute-force `vector::distance::X(field, $vec) +
		// ORDER BY` is always correct; HNSW still helps inserts and
		// can be used later via a dedicated unfiltered fast path.
		const whereClause = expr ? `WHERE ${expr} ` : '';
		const surql =
			`SELECT *, ${distExpr} AS __score__ ` +
			`FROM ${this.tableName} ` +
			`${whereClause}` +
			`ORDER BY __score__ ASC LIMIT ${k}`;

		const rows = await this.client.queryAll<
			DocumentRow & { __score__: number }
		>(surql, { vec: query, ...bindings });

		return rows.map((row) => {
			const content = String(row[this.contentField] ?? '');
			const metadata =
				(row[this.metadataField] as Record<string, unknown>) ?? {};
			const id = stringifyRecordId(row[this.idField]);
			const doc = new Document({
				pageContent: content,
				metadata,
				id,
			});
			return [doc, row.__score__];
		});
	}

	override async delete(params: {
		ids?: string[];
		filter?: Record<string, any>;
	}): Promise<void> {
		await this.initialize();

		if (params.ids && params.ids.length > 0) {
			const recordIds = params.ids.map(
				(id) => `${this.tableName}:${escapeId(id)}`,
			);
			await this.client.execute(
				`DELETE FROM ${this.tableName} WHERE id INSIDE $ids`,
				{ ids: recordIds },
			);
			return;
		}

		if (params.filter && Object.keys(params.filter).length > 0) {
			const { expr, bindings } = translateFilter(params.filter, {
				fieldPrefix: this.metadataField,
			});
			await this.client.execute(
				`DELETE FROM ${this.tableName} WHERE ${expr}`,
				bindings,
			);
			return;
		}

		throw new Error(
			'VectorStore.delete requires { ids } or { filter } — refusing to delete the entire table',
		);
	}

	private async applySchema(): Promise<void> {
		const tableDdl = defineTable(this.tableName, [
			{ name: this.contentField, type: 'TYPE string' },
			{
				name: this.metadataField,
				type: 'TYPE object FLEXIBLE DEFAULT {}',
			},
			{ name: this.vectorField, type: 'TYPE array<float>' },
		]);
		await this.client.execute(tableDdl);

		const indexDdl = defineVectorIndex({
			tableName: this.tableName,
			indexName: `${this.tableName}_${this.vectorField}_idx`,
			field: this.vectorField,
			dimensions: this.dimensions,
			distance: this.distanceStrategy,
			type: this.indexType,
			hnsw: this.hnswOptions,
			mtree: this.mtreeOptions,
		});
		if (indexDdl) await this.client.execute(indexDdl);
	}
}

function explicitDistance(strategy: DistanceStrategy, field: string): string {
	switch (strategy) {
		case 'cosine':
			return `(1.0 - vector::similarity::cosine(${field}, $vec))`;
		case 'euclidean':
			return `vector::distance::euclidean(${field}, $vec)`;
		case 'manhattan':
			return `vector::distance::manhattan(${field}, $vec)`;
		case 'hamming':
			return `vector::distance::hamming(${field}, $vec)`;
	}
}

function escapeId(id: string): string {
	if (/^[A-Za-z0-9_]+$/.test(id)) return id;
	return `⧼${id.replace(/`/g, '\\`')}⧽`;
}

function stringifyRecordId(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value !== null) {
		const obj = value as {
			tb?: string;
			id?: unknown;
			toString?: () => string;
		};
		if (obj.tb && obj.id !== undefined) {
			return `${obj.tb}:${String(obj.id)}`;
		}
		if (typeof obj.toString === 'function') return obj.toString();
	}
	return String(value);
}
