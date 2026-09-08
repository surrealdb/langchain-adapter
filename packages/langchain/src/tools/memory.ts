import { Document } from '@langchain/core/documents';
import { tool } from '@langchain/core/tools';
import {
	resolveAgentMemory,
	type AgentMemoryClientConfig,
} from '@surrealdb/langchain-core';
import { z } from 'zod';

interface ClientHolder {
	client: AgentMemoryClientConfig;
}

const queryToolSchema = z.object({
	query: z
		.string()
		.describe('Natural-language query for the Agent Memory knowledge base.'),
	k: z.number().int().positive().optional().describe('Max number of hits.'),
	mode: z
		.enum(['vector', 'bm25', 'hybrid', 'hybrid_graph'])
		.optional()
		.describe('Retrieval mode. Default: hybrid.'),
	filter: z
		.record(z.string(), z.any())
		.optional()
		.describe(
			'Optional metadata filter, e.g. {"mimeType": ["application/pdf"]}.',
		),
});

export interface AgentMemoryQueryToolArgs extends ClientHolder {
	name?: string;
	description?: string;
	defaultK?: number;
}

/**
 * Search the Agent Memory knowledge base.
 *
 * The model sees a readable digest; the caller gets the retrieved
 * `Document`s as the artifact, so nothing is lost to string flattening —
 * the same shape `createRetrieverTool` produces.
 */
export function createAgentMemoryQueryTool(args: AgentMemoryQueryToolArgs) {
	const client = resolveAgentMemory(args.client);
	const defaultK = args.defaultK ?? 10;

	return tool(
		async (input) => {
			const response = await client.documents.query({
				query: input.query,
				mode: input.mode,
				k: input.k ?? defaultK,
				filter: input.filter as never,
			});

			const documents = response.results.map(
				(hit) =>
					new Document({
						pageContent: hit.chunk.text,
						id: hit.document.id,
						metadata: {
							score: hit.score,
							documentId: hit.document.id,
							title: hit.document.title,
							source: hit.document.source,
						},
					}),
			);

			const content =
				documents.length === 0
					? 'No matching memory.'
					: documents
							.map(
								(d, i) =>
									`[${i + 1}] ${d.metadata.title ?? d.metadata.source ?? d.id}\n${d.pageContent}`,
							)
							.join('\n\n');

			return [content, documents];
		},
		{
			name: args.name ?? 'agent_memory_query',
			description:
				args.description ??
				'Search the SurrealDB Agent Memory knowledge base. Pass a ' +
					'natural-language query and optionally k, mode, or a metadata ' +
					'filter. Returns the top hits.',
			schema: queryToolSchema,
			responseFormat: 'content_and_artifact',
		},
	);
}

const reflectToolSchema = z.object({
	query: z
		.string()
		.describe(
			'What to reflect on, e.g. "patterns in customer complaints".',
		),
	persist: z
		.boolean()
		.optional()
		.describe('When true, persist the reflection as durable memory.'),
});

export interface AgentMemoryReflectToolArgs extends ClientHolder {
	name?: string;
	description?: string;
}

/**
 * Ask Agent Memory to reflect over what it knows.
 *
 * The model sees the reflection text; the full response rides along as the
 * artifact.
 */
export function createAgentMemoryReflectTool(
	args: AgentMemoryReflectToolArgs,
) {
	const client = resolveAgentMemory(args.client);

	return tool(
		async (input) => {
			const result = await client.reflect(input.query, {
				persist: input.persist,
			});
			const text =
				(result as { reflection?: string }).reflection ??
				JSON.stringify(result);
			return [text, result];
		},
		{
			name: args.name ?? 'agent_memory_reflect',
			description:
				args.description ??
				'Ask Agent Memory to reflect over its memory of a question. ' +
					'Returns the reflection text. Pass persist=true to durably ' +
					'store it.',
			schema: reflectToolSchema,
			responseFormat: 'content_and_artifact',
		},
	);
}
