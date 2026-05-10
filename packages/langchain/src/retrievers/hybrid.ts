import type { CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import {
	BaseRetriever as BaseLangChainRetriever,
	type BaseRetrieverInput,
} from '@langchain/core/retrievers';
import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import {
	assertIdent,
	SurrealDBClient,
	type SurrealDBStoreConfig,
	translateFilter,
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
	graphEdges?: string[];
	/** Number of seed vector hits before graph expansion. Default: 5. */
	seedK?: number;
	/** Maximum number of documents returned. Default: 10. */
	k?: number;
	/** Optional metadata filter applied to both the seed and final query. */
	filter?: Record<string, unknown>;
}

/**
 * Retriever that combines a vector kNN seed with a graph-walk over
 * SurrealDB edges, then re-ranks the union by vector distance.
 *
 * Useful when the document graph contains semantic neighbours that the
 * embedding alone wouldn't surface — e.g. follow-up answers, citations
 * or authored-by relationships.
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
		this.seedK = args.seedK ?? 5;
		this.k = args.k ?? 10;
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
		const filterClause = expr ? ` AND ${expr}` : '';

		const seedSurql =
			`SELECT id, ${this.contentField}, ${this.metadataField}, ${this.vectorField}, ` +
			`vector::distance::knn() AS __score__ ` +
			`FROM ${this.tableName} ` +
			`WHERE ${this.vectorField} <|${this.seedK}|> $vec${filterClause}`;
		const seeds = await this.client.queryAll<RawHit>(seedSurql, {
			vec,
			...bindings,
		});

		const fanout = new Map<string, RawHit>();
		for (const seed of seeds) {
			fanout.set(idKey(seed.id), seed);
		}

		for (const edge of this.graphEdges) {
			if (seeds.length === 0) break;
			const ids = seeds.map((s) => s.id);
			const expandSurql =
				`SELECT id, ${this.contentField}, ${this.metadataField}, ${this.vectorField} ` +
				`FROM ${this.tableName} ` +
				`WHERE id IN ((SELECT VALUE ->${edge}->${this.tableName} AS x ` +
				`FROM $seedIds).x.flatten())`;
			const neighbours = await this.client.queryAll<RawHit>(
				expandSurql,
				{ seedIds: ids },
			);
			for (const n of neighbours) {
				if (!fanout.has(idKey(n.id))) fanout.set(idKey(n.id), n);
			}
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
				id: idKey(row.id),
			});
		});
	}
}

interface RawHit {
	id: { tb: string; id: string } | string;
	[field: string]: unknown;
}

function idKey(id: RawHit['id']): string {
	if (typeof id === 'string') return id;
	if (id && typeof id === 'object') return `${id.tb}:${id.id}`;
	return String(id);
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
