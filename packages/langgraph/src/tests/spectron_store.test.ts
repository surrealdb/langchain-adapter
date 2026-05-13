import { SpectronClient } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { SpectronStore } from '../spectron_store.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeStore(handler: (url: string, init?: RequestInit) => Response) {
	const fetchMock = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) =>
			handler(String(input), init),
	);
	const client = new SpectronClient({
		context: 'ctx',
		apiKey: 'sk-test',
		endpoint: 'https://api.example.test',
		fetch: fetchMock as unknown as typeof fetch,
		maxRetries: 0,
	});
	return { store: new SpectronStore({ spectron: client }), fetchMock };
}

describe('SpectronStore', () => {
	it('get returns null on 404', async () => {
		const { store } = makeStore(() =>
			jsonResponse({ title: 'not found' }, 404),
		);
		const result = await store.get(['Person'], 'tobie');
		expect(result).toBeNull();
	});

	it('get maps entity to Item', async () => {
		const { store } = makeStore(() =>
			jsonResponse({
				type: 'Person',
				name: 'tobie',
				attributes: { role: 'CTO' },
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			}),
		);
		const item = await store.get(['Person'], 'tobie');
		expect(item).not.toBeNull();
		expect(item?.key).toBe('tobie');
		expect(item?.namespace).toEqual(['Person']);
		expect(item?.value).toEqual({ role: 'CTO' });
		expect(item?.updatedAt.toISOString()).toBe('2024-01-02T00:00:00.000Z');
	});

	it('search calls /query and maps hits to SearchItem[]', async () => {
		const { store, fetchMock } = makeStore((url) => {
			expect(url).toBe('https://api.example.test/api/v1/ctx/query');
			return jsonResponse({
				hits: [
					{
						id: 'mem:1',
						source: 'memory',
						score: 0.9,
						text: 'tobie is CTO',
					},
					{
						id: 'mem:2',
						source: 'memory',
						score: 0.7,
						text: 'background',
					},
				],
			});
		});
		const items = await store.search(['Person'], {
			query: 'who is tobie?',
			limit: 5,
		});
		expect(items).toHaveLength(2);
		expect(items[0]!.score).toBe(0.9);
		expect(items[0]!.key).toBe('mem:1');
		expect(items[0]!.namespace).toEqual(['Person']);
		expect((items[0]!.value as { text: string }).text).toBe('tobie is CTO');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('search throws when no query is provided', async () => {
		const { store } = makeStore(() => jsonResponse({}));
		await expect(store.search(['Person'])).rejects.toThrow(
			/requires a `query`/,
		);
	});

	it('put throws a clear unsupported error', async () => {
		const { store } = makeStore(() => jsonResponse({}));
		await expect(
			store.put(['Person'], 'tobie', { role: 'CTO' }),
		).rejects.toThrow(/does not support put/);
	});

	it('listNamespaces throws', async () => {
		const { store } = makeStore(() => jsonResponse({}));
		await expect(store.listNamespaces()).rejects.toThrow(/listNamespaces/);
	});
});
