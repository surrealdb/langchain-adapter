import { Spectron } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { SpectronRetriever } from '../retrievers/spectron.js';
import { SpectronQueryTool, SpectronReflectTool } from '../tools/spectron.js';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function mockedClient(handler: (url: string) => unknown): Spectron {
	const fetchMock = vi.fn(async (input: string | URL | Request) =>
		jsonResponse(handler(String(input))),
	);
	return new Spectron({
		context: 'ctx',
		apiKey: 'sk-test',
		endpoint: 'https://api.example.test',
		fetch: fetchMock as unknown as typeof fetch,
		maxRetries: 0,
	});
}

describe('SpectronRetriever', () => {
	it('translates Spectron knowledge.query hits to LangChain Documents', async () => {
		const client = mockedClient(() => ({
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
		}));
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
		const client = mockedClient(() => ({
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
		}));
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
		const client = mockedClient(() => ({
			reflection: 'thinking…',
		}));
		const tool = new SpectronReflectTool({ client });
		const out = await tool.invoke({ query: 'why?' });
		expect(JSON.parse(out as string)).toEqual({ reflection: 'thinking…' });
	});
});
