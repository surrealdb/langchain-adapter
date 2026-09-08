import { Document } from '@langchain/core/documents';
import { ToolMessage } from '@langchain/core/messages';
import { AgentMemory } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { AgentMemoryRetriever } from '../retrievers/memory.js';
import {
	createAgentMemoryQueryTool,
	createAgentMemoryReflectTool,
} from '../tools/memory.js';

// Builds a real AgentMemory client (so `instanceof` checks pass) with the specific
// methods the adapters call stubbed out — no network, no `fetchImpl`.
function fakeClient(overrides: {
	query?: (args: unknown) => unknown;
	reflect?: (query: string, opts?: unknown) => unknown;
}): AgentMemory {
	const client = new AgentMemory({
		context: 'ctx',
		apiKey: 'sk-test',
		endpoint: 'https://api.example.test',
	});
	if (overrides.query) {
		(client.documents as unknown as { query: unknown }).query = vi.fn(
			overrides.query,
		);
	}
	if (overrides.reflect) {
		(client as unknown as { reflect: unknown }).reflect = vi.fn(
			overrides.reflect,
		);
	}
	return client;
}

describe('AgentMemoryRetriever', () => {
	it('translates Agent Memory documents.query hits to LangChain Documents', async () => {
		const client = fakeClient({
			query: () => ({
				queryMs: 5,
				results: [
					{
						chunk: {
							id: 'c1',
							document: 'd1',
							position: 0,
							charStart: 0,
							charEnd: 10,
							text: 'hello',
							section: 'intro',
						},
						document: {
							id: 'd1',
							title: 'Greetings',
							source: 'file.txt',
						},
						score: 0.91,
						graphEvidence: [
							{
								edgeKind: 'related',
								neighbourLabel: 'foo',
								weight: 0.5,
							},
						],
					},
				],
			}),
		});
		const retriever = new AgentMemoryRetriever({ client, k: 5 });
		const docs = await retriever.invoke('hi');
		expect(docs).toHaveLength(1);
		expect(docs[0]!.pageContent).toBe('hello');
		expect(docs[0]!.metadata.score).toBe(0.91);
		expect(docs[0]!.metadata.documentId).toBe('d1');
		expect(docs[0]!.metadata.title).toBe('Greetings');
		expect(docs[0]!.metadata.chunk).toEqual({
			position: 0,
			charStart: 0,
			charEnd: 10,
			section: 'intro',
		});
		expect(docs[0]!.metadata.graphEvidence).toHaveLength(1);
	});
});

describe('agent_memory_query tool', () => {
	const client = () =>
		fakeClient({
			query: () => ({
				queryMs: 1,
				results: [
					{
						chunk: {
							id: 'c1',
							document: 'd1',
							position: 0,
							charStart: 0,
							charEnd: 3,
							text: 'foo',
						},
						document: { id: 'd1', title: 'T', source: 's' },
						score: 0.5,
					},
				],
			}),
		});

	it('gives the model a readable digest', async () => {
		const tool = createAgentMemoryQueryTool({ client: client() });
		const out = await tool.invoke({ query: 'foo' });
		expect(out).toContain('T');
		expect(out).toContain('foo');
	});

	it('carries the hits as Documents in the artifact', async () => {
		// Flattening them into a string loses the metadata the caller needs.
		const tool = createAgentMemoryQueryTool({ client: client() });
		const msg = (await tool.invoke({
			type: 'tool_call',
			id: '1',
			name: tool.name,
			args: { query: 'foo' },
		})) as ToolMessage;
		const docs = msg.artifact as Document[];
		expect(docs).toHaveLength(1);
		expect(docs[0]).toBeInstanceOf(Document);
		expect(docs[0]?.pageContent).toBe('foo');
		expect(docs[0]?.metadata).toMatchObject({
			score: 0.5,
			documentId: 'd1',
			title: 'T',
			source: 's',
		});
	});

	it('is named agent_memory_query', () => {
		expect(createAgentMemoryQueryTool({ client: client() }).name).toBe(
			'agent_memory_query',
		);
	});

	it('says so plainly when nothing matches', async () => {
		const tool = createAgentMemoryQueryTool({
			client: fakeClient({ query: () => ({ queryMs: 1, results: [] }) }),
		});
		expect(await tool.invoke({ query: 'foo' })).toBe('No matching memory.');
	});
});

describe('agent_memory_reflect tool', () => {
	const client = () =>
		fakeClient({
			reflect: () => ({
				reflection: 'thinking…',
				evidence: [],
				persistedAttributes: [],
				traceId: '',
			}),
		});

	it('returns the reflection text to the model', async () => {
		const tool = createAgentMemoryReflectTool({ client: client() });
		expect(await tool.invoke({ query: 'why?' })).toBe('thinking…');
	});

	it('keeps the full response as the artifact', async () => {
		const tool = createAgentMemoryReflectTool({ client: client() });
		const msg = (await tool.invoke({
			type: 'tool_call',
			id: '1',
			name: tool.name,
			args: { query: 'why?' },
		})) as ToolMessage;
		expect(msg.artifact).toMatchObject({ reflection: 'thinking…' });
	});

	it('is named agent_memory_reflect', () => {
		expect(createAgentMemoryReflectTool({ client: client() }).name).toBe(
			'agent_memory_reflect',
		);
	});
});
