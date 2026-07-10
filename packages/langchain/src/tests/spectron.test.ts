import { Spectron } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { SpectronRetriever } from '../retrievers/spectron.js';
import { SpectronQueryTool, SpectronReflectTool } from '../tools/spectron.js';

// Builds a real Spectron (so `instanceof` checks pass) with the specific
// methods the adapters call stubbed out — no network, no `fetchImpl`.
function fakeClient(overrides: {
	query?: (args: unknown) => unknown;
	reflect?: (query: string, opts?: unknown) => unknown;
}): Spectron {
	const client = new Spectron({
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

describe('SpectronRetriever', () => {
	it('translates Spectron documents.query hits to LangChain Documents', async () => {
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
		const retriever = new SpectronRetriever({ client, k: 5 });
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

describe('SpectronQueryTool', () => {
	it('returns a compact JSON of hits', async () => {
		const client = fakeClient({
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
		const tool = new SpectronQueryTool({ client });
		const out = await tool.invoke({ query: 'foo' });
		const parsed = JSON.parse(out as string);
		expect(parsed).toEqual([
			{
				text: 'foo',
				score: 0.5,
				documentId: 'd1',
				title: 'T',
				source: 's',
			},
		]);
	});
});

describe('SpectronReflectTool', () => {
	it('returns the reflection JSON', async () => {
		const client = fakeClient({
			reflect: () => ({
				reflection: 'thinking…',
				evidence: [],
				persistedAttributes: [],
				traceId: '',
			}),
		});
		const tool = new SpectronReflectTool({ client });
		const out = await tool.invoke({ query: 'why?' });
		expect(JSON.parse(out as string)).toMatchObject({
			reflection: 'thinking…',
		});
	});
});
