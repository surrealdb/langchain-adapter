import { Document } from '@langchain/core/documents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VectorStore } from '../vectorstores/surrealdb.js';
import { FakeEmbeddings, makeConfig } from './helpers.js';

const cfg = makeConfig('vec');
const dims = 16;
let store: VectorStore;

beforeAll(async () => {
	store = await VectorStore.initialize(new FakeEmbeddings(dims), {
		surreal: cfg,
		dimensions: dims,
		distanceStrategy: 'cosine',
		indexType: 'hnsw',
	});
});

afterAll(async () => {
	await store?.close();
});

describe('VectorStore', () => {
	it('round-trips addDocuments → similaritySearch', async () => {
		await store.addDocuments([
			new Document({
				pageContent: 'apples and oranges grow on trees',
				metadata: { tag: 'fruit' },
			}),
			new Document({
				pageContent: 'cars and trucks drive on roads',
				metadata: { tag: 'vehicle' },
			}),
			new Document({
				pageContent: 'oranges are citrus fruits',
				metadata: { tag: 'fruit' },
			}),
		]);

		const hits = await store.similaritySearch('orange citrus', 2);
		expect(hits).toHaveLength(2);
		expect(hits.some((d) => d.metadata?.tag === 'fruit')).toBe(true);
	});

	it('respects metadata filters', async () => {
		const hits = await store.similaritySearchWithScore('orange citrus', 3, {
			tag: 'vehicle',
		});
		for (const [doc] of hits) {
			expect(doc.metadata?.tag).toBe('vehicle');
		}
	});

	it('refuses delete without ids or filter', async () => {
		await expect(store.delete({})).rejects.toThrow(/refusing/);
	});
});
