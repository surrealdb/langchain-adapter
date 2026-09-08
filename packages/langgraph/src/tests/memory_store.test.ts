import { AgentMemory, AgentMemoryNotFoundError } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { AgentMemoryStore } from '../memory_store.js';

// Builds a real AgentMemory client (so `instanceof` passes) with the methods the store
// calls stubbed out — no network, no `fetchImpl`.
function makeStore(overrides: {
	entitiesGet?: (type: string, name: string) => unknown;
	recall?: (query: string, opts?: unknown) => unknown;
	args?: Partial<ConstructorParameters<typeof AgentMemoryStore>[0]>;
}) {
	const client = new AgentMemory({
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
	return {
		client,
		recall,
		store: new AgentMemoryStore({ client, ...(overrides.args ?? {}) }),
	};
}

describe('AgentMemoryStore', () => {
	it('get returns null on 404', async () => {
		const { store } = makeStore({
			entitiesGet: () => {
				throw new AgentMemoryNotFoundError({
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
		const items = await store.search([], {
			query: 'who is tobie?',
			limit: 5,
		});
		expect(items).toHaveLength(2);
		expect(items[0]?.score).toBe(0.9);
		expect(items[0]?.key).toBe('mem:1');
		expect((items[0]?.value as { text: string }).text).toBe('tobie is CTO');
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

describe('AgentMemoryStore namespace handling', () => {
	const hits = {
		hits: [{ id: 'm1', source: 'memory', score: 1, text: 't' }],
	};

	it('refuses a namespace prefix by default rather than mislabelling', async () => {
		// Recall has no namespace dimension. Returning unscoped hits tagged
		// with the requested prefix is worse than refusing.
		const { store } = makeStore({ recall: () => hits });
		await expect(
			store.search(['Person'], { query: 'q' }),
		).rejects.toThrow(/cannot scope to namespace \[Person\]/);
	});

	it("reports namespace [] under 'ignore', never the unapplied prefix", async () => {
		const { store } = makeStore({
			recall: () => hits,
			args: { namespaceMode: 'ignore' },
		});
		const items = await store.search(['Person'], { query: 'q' });
		expect(items[0]?.namespace).toEqual([]);
	});

	it("maps the namespace onto a scope lens under 'lens'", async () => {
		const { store, recall } = makeStore({
			recall: () => hits,
			args: { namespaceMode: 'lens' },
		});
		const items = await store.search(['org', 'acme'], { query: 'q' });
		expect(recall).toHaveBeenCalledWith(
			'q',
			expect.objectContaining({ lens: [['org/acme']] }),
		);
		// Now the prefix was genuinely applied, so echoing it is accurate.
		expect(items[0]?.namespace).toEqual(['org', 'acme']);
	});

	it('an empty prefix always searches everything', async () => {
		const { store } = makeStore({ recall: () => hits });
		const items = await store.search([], { query: 'q' });
		expect(items[0]?.namespace).toEqual([]);
	});
});

describe('AgentMemoryStore search options', () => {
	const many = {
		hits: [1, 2, 3, 4].map((n) => ({
			id: `m${n}`,
			source: 'memory',
			score: 1 / n,
			text: `t${n}`,
		})),
	};

	it('over-fetches and slices, since recall has no offset', async () => {
		const { store, recall } = makeStore({ recall: () => many });
		const items = await store.search([], {
			query: 'q',
			limit: 2,
			offset: 1,
		});
		expect(recall).toHaveBeenCalledWith(
			'q',
			expect.objectContaining({ k: 3 }),
		);
		expect(items.map((i) => i.key)).toEqual(['m2', 'm3']);
	});

	it('translates a flat filter into label constraints', async () => {
		const { store, recall } = makeStore({ recall: () => many });
		await store.search([], { query: 'q', filter: { team: 'eng' } });
		expect(recall).toHaveBeenCalledWith(
			'q',
			expect.objectContaining({ labels: ['team=eng'] }),
		);
	});

	it('refuses an operator filter it cannot express', async () => {
		const { store } = makeStore({ recall: () => many });
		await expect(
			store.search([], { query: 'q', filter: { n: { $gt: 1 } } }),
		).rejects.toThrow(/exact key=value label matches/);
	});

	it('reports unknown timestamps as the epoch, not as "now"', async () => {
		const { store } = makeStore({ recall: () => many });
		const items = await store.search([], { query: 'q' });
		expect(items[0]?.createdAt.getTime()).toBe(0);
	});
});

describe('AgentMemoryStore batch isolation', () => {
	it('lets a failing op fail without taking concurrent reads with it', async () => {
		// AsyncBatchedStore coalesces concurrent calls into one batch, so a
		// mixed batch is the normal case.
		const { store } = makeStore({
			entitiesGet: () => ({
				entity: {
					entityType: 'Person',
					name: 'tobie',
					createdAt: null,
					updatedAt: null,
				},
				attributes: [{ key: 'role', value: 'CTO' }],
			}),
		});
		const [get, put] = await store.batch([
			{ namespace: ['Person'], key: 'tobie' },
			{ namespace: ['Person'], key: 'x', value: { a: 1 } },
		]);
		await expect(Promise.resolve(get)).resolves.toMatchObject({
			key: 'tobie',
		});
		await expect(Promise.resolve(put)).rejects.toThrow(
			/does not support put/,
		);
	});

	it('still throws for a lone unsupported op, so put() rejects', async () => {
		const { store } = makeStore({});
		await expect(
			store.put(['Person'], 'tobie', { role: 'CTO' }),
		).rejects.toThrow(/does not support put/);
	});
});
