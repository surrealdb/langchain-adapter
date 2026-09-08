import type { CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import { Document, type DocumentInterface } from '@langchain/core/documents';
import {
	BaseRetriever as BaseLangChainRetriever,
	type BaseRetrieverInput,
} from '@langchain/core/retrievers';
import {
	resolveAgentMemory,
	type AgentMemory,
	type AgentMemoryClientConfig,
	type AgentMemoryQueryMode,
} from '@surrealdb/langchain-core';

export interface AgentMemoryRetrieverArgs extends BaseRetrieverInput {
	client: AgentMemoryClientConfig;
	mode?: AgentMemoryQueryMode;
	k?: number;
	threshold?: number;
	rrfK?: number;
	graphAlpha?: number;
	graphEdges?: string[];
	graphDepth?: number;
	expandGraph?: boolean;
	filter?: Record<string, unknown>;
}

export class AgentMemoryRetriever extends BaseLangChainRetriever {
	override lc_namespace = [
		'langchain',
		'retrievers',
		'surrealdb',
		'agent_memory',
	];

	readonly client: AgentMemory;
	readonly mode: AgentMemoryQueryMode;
	readonly k: number;
	readonly threshold?: number;
	readonly rrfK?: number;
	readonly graphAlpha?: number;
	readonly graphEdges?: string[];
	readonly graphDepth?: number;
	readonly expandGraph?: boolean;
	readonly filter?: Record<string, unknown>;

	constructor(args: AgentMemoryRetrieverArgs) {
		super(args);
		this.client = resolveAgentMemory(args.client);
		this.mode = args.mode ?? 'hybrid';
		this.k = args.k ?? 10;
		this.threshold = args.threshold;
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
		const response = await this.client.documents.query({
			query,
			mode: this.mode,
			k: this.k,
			threshold: this.threshold,
			rrfK: this.rrfK,
			graphAlpha: this.graphAlpha,
			graphEdges: this.graphEdges as never,
			graphDepth: this.graphDepth,
			expandGraph: this.expandGraph,
			filter: this.filter as never,
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
