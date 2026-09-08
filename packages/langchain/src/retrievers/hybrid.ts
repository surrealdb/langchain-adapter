import type { CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import {
	BaseRetriever as BaseLangChainRetriever,
	type BaseRetrieverInput,
} from '@langchain/core/retrievers';
import {
	assertCount,
	assertIdent,
	knnPredicate,
	recordIdToString,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	translateFilter,
	type VectorIndexType,
} from '@surrealdb/langchain-core';

export interface HybridRetrieverArgs extends BaseRetrieverInput {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	embeddings: EmbeddingsInterface;
	tableName?: string;
	contentField?: string;
	metadataField?: string;
	vectorField?: string;
	/**
	 * Edge tables to walk after the vector seed lookup. For each edge,
	 * the retriever fans out from each seed via `->edge->?`. Pass `[]` to
	 * disable graph expansion (then the retriever behaves like a plain
	 * vector retriever).
	 */
	/**
	 * Graph edges to fan out over from the vector seeds.
	 *
	 * Not yet supported — see the note on {@link HybridRetriever}. Passing a
	 * non-empty list throws rather than silently returning no neighbours.
	 */
	graphEdges?: string[];
	/** Vector index defined on `vectorField`. Default `'hnsw'`. */
	indexType?: VectorIndexType;
	/** Search breadth for the graph index. Default 40. */
	ef?: number;
	/** Number of seed vector hits before graph expansion. Default: 5. */
	seedK?: number;
	/** Maximum number of documents returned. Default: 10. */
	k?: number;
	/** Optional metadata filter applied to both the seed and final query. */
	filter?: Record<string, unknown>;
}

/**
 * Retriever that seeds from a vector kNN search and re-ranks by distance.
 *
 * **Graph expansion is not yet supported.** The intent is to fan out over
 * SurrealDB edges from the vector seeds and re-rank the union, surfacing
 * semantic neighbours an embedding alone would miss. The previous
 * implementation could not work — under `SELECT VALUE` the `AS` alias is
 * discarded, so the fan-out was always empty — and it was never covered by a
 * test. Rather than keep returning zero neighbours silently, `graphEdges`
 * now throws; the feature will land with an integration test behind it.
 */
export class HybridRetriever extends BaseLangChainRetriever {
	override lc_namespace = ['langchain', 'retrievers', 'surrealdb'];

	readonly client: SurrealDBClient;
	readonly embeddings: EmbeddingsInterface;
	readonly tableName: string;
	readonly contentField: string;
	readonly metadataField: string;
	readonly vectorField: string;
	readonly graphEdges: string[];
	readonly seedK: number;
	readonly k: number;
	readonly indexType: VectorIndexType;
	readonly ef: number;
	readonly filter: Record<string, unknown> | undefined;
	private readonly ownsClient: boolean;
	private connected = false;

	constructor(args: HybridRetrieverArgs) {
		super(args);
		this.embeddings = args.embeddings;
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
		this.graphEdges = (args.graphEdges ?? []).map((e) =>
			assertIdent(e, 'edge'),
		);
		if (this.graphEdges.length > 0) {
			throw new Error(
				'HybridRetriever: graph expansion (`graphEdges`) is not yet ' +
					'supported — the previous implementation always returned ' +
					'zero neighbours. Omit `graphEdges` to use vector search ' +
					'alone; graph expansion will return in a later release.',
			);
		}
		this.seedK = assertCount(args.seedK ?? 5, 'seedK');
		this.k = assertCount(args.k ?? 10, 'k');
		this.indexType = args.indexType ?? 'hnsw';
		this.ef = args.ef ?? 40;
		this.filter = args.filter;

		if (args.surreal instanceof SurrealDBClient) {
			this.client = args.surreal;
			this.ownsClient = false;
		} else {
			this.client = new SurrealDBClient(args.surreal);
			this.ownsClient = true;
		}
	}

	private async ensureConnected(): Promise<void> {
		if (this.connected) return;
		await this.client.connect();
		this.connected = true;
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	override async _getRelevantDocuments(
		query: string,
		_runManager?: CallbackManagerForRetrieverRun,
	): Promise<DocumentInterface[]> {
		await this.ensureConnected();
		const vec = await this.embeddings.embedQuery(query);

		const { expr, bindings } = translateFilter(this.filter, {
			fieldPrefix: this.metadataField,
		});

		// `<|k,EF|>` against the graph index, or `<|k,METRIC|>` brute force.
		// The old single-argument `<|k|>` is rejected outright by SurrealDB
		// v3 — "the `<|k|>` KNN operator (KTree / M-Tree) is no longer
		// supported" — so this path could never have run against a v3 server.
		const { predicate, distanceExpr } = knnPredicate({
			field: this.vectorField,
			k: this.seedK,
			distance: 'cosine',
			indexType: this.indexType,
			ef: this.ef,
		});
		const conditions = expr ? `${predicate} AND ${expr}` : predicate;

		const seedSurql =
			`SELECT id, ${this.contentField}, ${this.metadataField}, ${this.vectorField}, ` +
			`${distanceExpr} AS __score__ ` +
			`FROM ${this.tableName} ` +
			`WHERE ${conditions}`;
		const seeds = await this.client.queryAll<RawHit>(seedSurql, {
			vec,
			...bindings,
		});

		const fanout = new Map<string, RawHit>();
		for (const seed of seeds) {
			fanout.set(recordIdToString(seed.id), seed);
		}

		const ranked = [...fanout.values()].map((row) => ({
			row,
			score: cosineDistance(vec, row[this.vectorField] as number[]),
		}));
		ranked.sort((a, b) => a.score - b.score);

		return ranked.slice(0, this.k).map(({ row }) => {
			return new Document({
				pageContent: String(row[this.contentField] ?? ''),
				metadata:
					(row[this.metadataField] as Record<string, unknown>) ?? {},
				id: recordIdToString(row.id),
			});
		});
	}
}

interface RawHit {
	id: unknown;
	[field: string]: unknown;
}


function cosineDistance(a: number[], b: number[]): number {
	if (a.length !== b.length) return Number.POSITIVE_INFINITY;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 1;
	return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
