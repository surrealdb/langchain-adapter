import type { CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import { Document, type DocumentInterface } from '@langchain/core/documents';
import {
	BaseRetriever as BaseLangChainRetriever,
	type BaseRetrieverInput,
} from '@langchain/core/retrievers';
import {
	SpectronClient,
	type SpectronConfig,
	type SpectronQueryMode,
} from '@surrealdb/langchain-core';
import type { QueryFilter } from '@surrealdb/langchain-core/spectron';

export interface SpectronRetrieverArgs extends BaseRetrieverInput {
	client: SpectronClient | SpectronConfig;
	mode?: SpectronQueryMode;
	k?: number;
	threshold?: number;
	vectorWeight?: number;
	rrfK?: number;
	graphAlpha?: number;
	graphEdges?: string[];
	graphDepth?: number;
	expandGraph?: boolean;
	filter?: QueryFilter | Record<string, unknown>;
}

export class SpectronRetriever extends BaseLangChainRetriever {
	override lc_namespace = [
		'langchain',
		'retrievers',
		'surrealdb',
		'spectron',
	];

	readonly client: SpectronClient;
	readonly mode: SpectronQueryMode;
	readonly k: number;
	readonly threshold?: number;
	readonly vectorWeight?: number;
	readonly rrfK?: number;
	readonly graphAlpha?: number;
	readonly graphEdges?: string[];
	readonly graphDepth?: number;
	readonly expandGraph?: boolean;
	readonly filter?: QueryFilter | Record<string, unknown>;

	constructor(args: SpectronRetrieverArgs) {
		super(args);
		this.client =
			args.client instanceof SpectronClient
				? args.client
				: new SpectronClient(args.client);
		this.mode = args.mode ?? 'hybrid';
		this.k = args.k ?? 10;
		this.threshold = args.threshold;
		this.vectorWeight = args.vectorWeight;
		this.rrfK = args.rrfK;
		this.graphAlpha = args.graphAlpha;
		this.graphEdges = args.graphEdges;
		this.graphDepth = args.graphDepth;
		this.expandGraph = args.expandGraph;
		this.filter = args.filter;
	}

	override async _getRelevantDocuments(
		query: string,
		_runManager?: CallbackManagerForRetrieverRun,
	): Promise<DocumentInterface[]> {
		const response = await this.client.knowledge.query(query, {
			mode: this.mode,
			k: this.k,
			threshold: this.threshold,
			vectorWeight: this.vectorWeight,
			rrfK: this.rrfK,
			graphAlpha: this.graphAlpha,
			graphEdges: this.graphEdges,
			graphDepth: this.graphDepth,
			expandGraph: this.expandGraph,
			filter: this.filter,
		});

		return response.results.map(
			(hit) =>
				new Document({
					pageContent: hit.chunk.text,
					metadata: {
						score: hit.score,
						documentId: hit.document.id,
						title: hit.document.title,
						source: hit.document.source,
						chunkId: hit.chunk.id,
						chunk: {
							position: hit.chunk.position,
							charStart: hit.chunk.charStart,
							charEnd: hit.chunk.charEnd,
							section: hit.chunk.section ?? undefined,
						},
						graphEvidence: hit.graphEvidence ?? undefined,
					},
				}),
		);
	}
}
