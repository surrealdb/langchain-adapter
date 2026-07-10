import { Spectron, SpectronNotFoundError } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { SpectronStore } from '../spectron_store.js';

// Builds a real Spectron (so `instanceof` passes) with the methods the store
// calls stubbed out — no network, no `fetchImpl`.
function makeStore(overrides: {
	entitiesGet?: (type: string, name: string) => unknown;
	recall?: (query: string, opts?: unknown) => unknown;
}) {
	const client = new Spectron({
		context: 'ctx',
		apiKey: 'sk-test',
		endpoint: 'https://api.example.test',
	});
	const recall = vi.fn(overrides.recall ?? (() => ({ hits: [] })));
	if (overrides.entitiesGet) {
		(client.entities as unknown as { get: unknown }).get = vi.fn(
			overrides.entitiesGet,
		);
	}
	(client as unknown as { recall: unknown }).recall = recall;
	return { store: new SpectronStore({ spectron: client }), recall };
}

describe('SpectronStore', () => {
	it('get returns null on 404', async () => {
		const { store } = makeStore({
			entitiesGet: () => {
				throw new SpectronNotFoundError({
					status: 404,
					title: 'not found',
				});
			},
		});
		const result = await store.get(['Person'], 'tobie');
		expect(result).toBeNull();
	});

	it('get maps entity to Item', async () => {
		const { store } = makeStore({
			entitiesGet: () => ({
				entity: {
					id: 'entity:1',
					entityType: 'Person',
					name: 'tobie',
					importance: 1,
					memoryCategory: 'identity',
					createdAt: '2024-01-01T00:00:00Z',
					updatedAt: '2024-01-02T00:00:00Z',
				},
				attributes: [
					{
						id: 'attr:1',
						entity: 'entity:1',
						key: 'role',
						value: 'CTO',
						importance: 1,
						memoryCategory: 'identity',
						createdAt: '2024-01-01T00:00:00Z',
					},
				],
				relations: [],
			}),
		});
		const item = await store.get(['Person'], 'tobie');
		expect(item).not.toBeNull();
		expect(item?.key).toBe('tobie');
		expect(item?.namespace).toEqual(['Person']);
		expect(item?.value).toEqual({ role: 'CTO' });
		expect(item?.updatedAt.toISOString()).toBe('2024-01-02T00:00:00.000Z');
	});

	it('search calls recall and maps hits to SearchItem[]', async () => {
		const { store, recall } = makeStore({
			recall: (query: string) => {
				expect(query).toBe('who is tobie?');
				return {
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
				};
			},
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
		expect(recall).toHaveBeenCalledOnce();
	});

	it('search throws when no query is provided', async () => {
		const { store } = makeStore({});
		await expect(store.search(['Person'])).rejects.toThrow(
			/requires a `query`/,
		);
	});

	it('put throws a clear unsupported error', async () => {
		const { store } = makeStore({});
		await expect(
			store.put(['Person'], 'tobie', { role: 'CTO' }),
		).rejects.toThrow(/does not support put/);
	});

	it('listNamespaces throws', async () => {
		const { store } = makeStore({});
		await expect(store.listNamespaces()).rejects.toThrow(/listNamespaces/);
	});
});
