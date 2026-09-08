import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { maximalMarginalRelevance } from '@langchain/core/utils/math';
import {
	VectorStore as BaseVectorStore,
	type MaxMarginalRelevanceSearchOptions,
} from '@langchain/core/vectorstores';
import {
	assertCount,
	assertIdent,
	type DistanceStrategy,
	defineTable,
	defineVectorIndex,
	knnPredicate,
	recordIdToString,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	toRecordId,
	translateFilter,
	type VectorIndexType,
} from '@surrealdb/langchain-core';

export type { DistanceStrategy, VectorIndexType };

export interface SurrealDBVectorStoreArgs {
	/** Either an existing client/config OR a fresh URL/token config. */
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	contentField?: string;
	metadataField?: string;
	vectorField?: string;
	dimensions: number;
	distanceStrategy?: DistanceStrategy;
	indexType?: VectorIndexType;
	hnswOptions?: { m?: number; efc?: number };
	diskannOptions?: { buildList?: number };
	/** Search breadth for the graph index. Default 40. */
	ef?: number;
	/**
	 * Direction of the number returned by
	 * {@link SurrealDBVectorStore.similaritySearchWithScore}. Defaults to
	 * `'similarity'` (higher is better), which is what the LangChain
	 * ecosystem — `ScoreThresholdRetriever` included — assumes. Set
	 * `'distance'` to restore the 0.1.x behaviour.
	 */
	scoreMode?: 'similarity' | 'distance';
	/** Skip schema/index creation (assume an external migration owns it). */
	skipInitSchema?: boolean;
	/** Skip the SurrealDB v3 server version check. */
	skipVersionCheck?: boolean;
}

interface DocumentRow {
	id: unknown;
	[field: string]: unknown;
}

/**
 * SurrealDB-backed vector store for LangChain.js.
 *
 * Uses SurrealDB's native HNSW (or MTREE) vector index. Requires SurrealDB
 * server v3.x.
 *
 * Construct via {@link SurrealDBVectorStore.initialize} (or the static
 * {@link fromTexts}/{@link fromDocuments} factories) — the synchronous
 * constructor cannot perform the connection or schema setup.
 */
export class SurrealDBVectorStore extends BaseVectorStore {
	declare FilterType: Record<string, any>;

	override _vectorstoreType(): string {
		return 'surrealdb';
	}

	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly contentField: string;
	readonly metadataField: string;
	readonly vectorField: string;
	readonly dimensions: number;
	readonly scoreMode: 'similarity' | 'distance';
	readonly distanceStrategy: DistanceStrategy;
	readonly indexType: VectorIndexType;
	readonly hnswOptions: { m?: number; efc?: number };
	readonly diskannOptions: { buildList?: number };
	readonly ef: number;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private initialised = false;

	constructor(embeddings: EmbeddingsInterface, args: SurrealDBVectorStoreArgs) {
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
		this.dimensions = args.dimensions;
		this.scoreMode = args.scoreMode ?? 'similarity';
		this.distanceStrategy = args.distanceStrategy ?? 'cosine';
		this.indexType = args.indexType ?? 'hnsw';
		this.hnswOptions = args.hnswOptions ?? {};
		this.diskannOptions = args.diskannOptions ?? {};
		this.ef = args.ef ?? 40;
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
		args: SurrealDBVectorStoreArgs,
	): Promise<SurrealDBVectorStore> {
		const store = new SurrealDBVectorStore(embeddings, args);
		await store.initialize();
		return store;
	}

	static override async fromTexts(
		texts: string[],
		metadatas: object[] | object,
		embeddings: EmbeddingsInterface,
		args: SurrealDBVectorStoreArgs,
	): Promise<SurrealDBVectorStore> {
		const docs = texts.map(
			(pageContent, i) =>
				new Document({
					pageContent,
					metadata: Array.isArray(metadatas)
						? (metadatas[i] ?? {})
						: metadatas,
				}),
		);
		return SurrealDBVectorStore.fromDocuments(docs, embeddings, args);
	}

	static override async fromDocuments(
		docs: DocumentInterface[],
		embeddings: EmbeddingsInterface,
		args: SurrealDBVectorStoreArgs,
	): Promise<SurrealDBVectorStore> {
		const store = await SurrealDBVectorStore.initialize(embeddings, args);
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
		// v1 convention: a Document may carry its own id.
		const ids =
			options?.ids ??
			(documents.every((d) => d.id) 
				? documents.map((d) => d.id as string)
				: undefined);
		return this.addVectors(vectors, documents, { ...options, ids });
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
				// A real RecordId, not `\`${table}:${id}\``. The driver
				// CBOR-encodes it, so the id part is never escaped or
				// re-parsed; a string here lands in the id part verbatim and
				// produces `table:⟨table:id⟩`.
				record.id = toRecordId(this.tableName, ids[i] as string);
			}
			return record;
		});

		// `ON DUPLICATE KEY UPDATE`, because a plain INSERT errors on an
		// existing primary key — which is exactly what re-indexing the same
		// id does (LangChain's `index()` with `forceUpdate`).
		const inserted = await this.client.queryAll<DocumentRow>(
			`INSERT INTO ${this.tableName} $records ` +
				`ON DUPLICATE KEY UPDATE ` +
				`${this.contentField} = $input.${this.contentField}, ` +
				`${this.metadataField} = $input.${this.metadataField}, ` +
				`${this.vectorField} = $input.${this.vectorField}`,
			{ records },
		);
		return inserted.map((row) => recordIdToString(row.id));
	}

	/**
	 * One SELECT behind both plain similarity search and MMR.
	 *
	 * `includeVectors` exists because MMR needs the embeddings to re-rank
	 * while ordinary search does not — and shipping a full embedding back for
	 * every hit is the single most expensive thing this query can do.
	 */
	private async _searchRows(
		query: number[],
		k: number,
		filter: this['FilterType'] | undefined,
		opts: { includeVectors: boolean },
	): Promise<{ doc: DocumentInterface; score: number; vector?: number[] }[]> {
		await this.initialize();

		const { expr, bindings } = translateFilter(filter, {
			fieldPrefix: this.metadataField,
		});

		// The KNN operator, so the HNSW/DISKANN index is actually used. An
		// extra WHERE is pushed into the graph traversal rather than applied
		// afterwards, so a filtered search still returns a full k.
		const { predicate, distanceExpr } = knnPredicate({
			field: this.vectorField,
			k: assertCount(k, 'k'),
			distance: this.distanceStrategy,
			indexType: this.indexType,
			ef: this.ef,
		});

		const projection = [
			'id',
			this.contentField,
			this.metadataField,
			...(opts.includeVectors ? [this.vectorField] : []),
		].join(', ');

		const conditions = expr ? `${predicate} AND ${expr}` : predicate;
		const surql =
			`SELECT ${projection}, ${distanceExpr} AS __distance__ ` +
			`FROM ${this.tableName} ` +
			`WHERE ${conditions} ` +
			`ORDER BY __distance__ ASC`;

		const rows = await this.client.queryAll<
			DocumentRow & { __distance__: number }
		>(surql, { vec: query, ...bindings });

		return rows.map((row) => {
			const doc = new Document({
				pageContent: String(row[this.contentField] ?? ''),
				metadata:
					(row[this.metadataField] as Record<string, unknown>) ?? {},
				id: recordIdToString(row.id),
			});
			return {
				doc,
				score: this.toScore(row.__distance__),
				vector: opts.includeVectors
					? (row[this.vectorField] as number[])
					: undefined,
			};
		});
	}

	/**
	 * Map a distance to the configured score direction.
	 *
	 * `1/(1+d)` for the unbounded metrics: monotonically decreasing in `d` and
	 * bounded to `(0, 1]`, so "higher is better" holds without pretending the
	 * result is a cosine similarity.
	 */
	private toScore(distance: number): number {
		if (this.scoreMode === 'distance') return distance;
		return this.distanceStrategy === 'cosine'
			? 1 - distance
			: 1 / (1 + distance);
	}

	override async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: this['FilterType'],
	): Promise<[DocumentInterface, number][]> {
		const rows = await this._searchRows(query, k, filter, {
			includeVectors: false,
		});
		return rows.map((r) => [r.doc, r.score]);
	}

	/**
	 * Maximal marginal relevance: over-fetch `fetchK`, then re-rank for a
	 * balance of relevance and diversity. Also what makes
	 * `asRetriever({ searchType: 'mmr' })` work — the base class checks for
	 * this method by name and throws without it.
	 */
	override async maxMarginalRelevanceSearch(
		query: string,
		options: MaxMarginalRelevanceSearchOptions<this['FilterType']>,
	): Promise<DocumentInterface[]> {
		const queryVector = await this.embeddings.embedQuery(query);
		const fetchK = options.fetchK ?? 20;
		const rows = await this._searchRows(
			queryVector,
			fetchK,
			options.filter,
			{ includeVectors: true },
		);
		if (rows.length === 0) return [];

		const picked = maximalMarginalRelevance(
			queryVector,
			rows.map((r) => r.vector ?? []),
			options.lambda ?? 0.5,
			options.k,
		);
		return picked
			.map((i) => rows[i]?.doc)
			.filter((d): d is DocumentInterface => d !== undefined);
	}

	override async delete(params: {
		ids?: string[];
		filter?: Record<string, any>;
	}): Promise<void> {
		await this.initialize();

		if (params.ids && params.ids.length > 0) {
			// Bind RecordIds, not strings: `id` is a RecordId server-side, so
			// comparing it against a string matches nothing and the delete
			// silently succeeds having removed no rows.
			const recordIds = params.ids.map((id) => {
				if (id.includes(':')) {
					throw new Error(
						`SurrealDBVectorStore.delete: ${JSON.stringify(id)} is a ` +
							`fully-qualified record id, which this store cannot ` +
							`rebuild losslessly. Use delete({ filter }) instead.`,
					);
				}
				return toRecordId(this.tableName, id);
			});
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
			'SurrealDBVectorStore.delete requires { ids } or { filter } — refusing to delete the entire table',
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
			diskann: this.diskannOptions,
		});
		if (indexDdl) await this.client.execute(indexDdl);
	}
}
