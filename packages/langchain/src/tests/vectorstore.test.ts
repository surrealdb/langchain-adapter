import { RecordId } from '@surrealdb/langchain-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SurrealDBVectorStore } from '../vectorstores/surrealdb.js';
import { FakeSurrealDBClient } from './fake_client.js';
import { FakeEmbeddings } from './helpers.js';

function makeStore(
	args: Partial<
		ConstructorParameters<typeof SurrealDBVectorStore>[1]
	> = {},
) {
	const client = new FakeSurrealDBClient();
	const store = new SurrealDBVectorStore(new FakeEmbeddings(4), {
		surreal: client,
		dimensions: 4,
		skipInitSchema: true,
		skipVersionCheck: true,
		...args,
	});
	return { client, store };
}

describe('SurrealDBVectorStore ids', () => {
	let client: FakeSurrealDBClient;
	let store: SurrealDBVectorStore;
	beforeEach(() => {
		({ client, store } = makeStore());
	});

	it('writes a RecordId, not a "table:id" string', async () => {
		client.rows = [[{ id: new RecordId('documents', 'plain') }]];
		await store.addVectors(
			[[1, 0, 0, 0]],
			[{ pageContent: 'a', metadata: {} }],
			{ ids: ['plain'] },
		);
		const records = client.only().bindings?.records as Record<
			string,
			unknown
		>[];
		expect(records[0]?.id).toBeInstanceOf(RecordId);
		expect((records[0]?.id as RecordId).id).toBe('plain');
	});

	it('leaves the id to the server when none is supplied', async () => {
		client.rows = [[{ id: new RecordId('documents', 'gen') }]];
		await store.addVectors(
			[[1, 0, 0, 0]],
			[{ pageContent: 'a', metadata: {} }],
		);
		const records = client.only().bindings?.records as Record<
			string,
			unknown
		>[];
		expect(records[0]).not.toHaveProperty('id');
	});

	it('returns the bare id part, so ids round-trip into delete()', async () => {
		client.rows = [
			[
				{ id: new RecordId('documents', 'plain') },
				{ id: new RecordId('documents', 'has space') },
			],
		];
		const ids = await store.addVectors(
			[
				[1, 0, 0, 0],
				[0, 1, 0, 0],
			],
			[
				{ pageContent: 'a', metadata: {} },
				{ pageContent: 'b', metadata: {} },
			],
			{ ids: ['plain', 'has space'] },
		);
		expect(ids).toEqual(['plain', 'has space']);
	});

	it('upserts rather than failing on a duplicate primary key', async () => {
		client.rows = [[]];
		await store.addVectors(
			[[1, 0, 0, 0]],
			[{ pageContent: 'a', metadata: {} }],
			{ ids: ['dup'] },
		);
		expect(client.only().surql).toContain('ON DUPLICATE KEY UPDATE');
	});

	it('deletes by binding RecordIds, not strings', async () => {
		await store.delete({ ids: ['has space'] });
		const ids = client.only().bindings?.ids as unknown[];
		expect(ids[0]).toBeInstanceOf(RecordId);
		expect((ids[0] as RecordId).id).toBe('has space');
	});

	it('refuses a qualified id it cannot rebuild losslessly', async () => {
		await expect(store.delete({ ids: ['documents:x'] })).rejects.toThrow(
			/fully-qualified record id.*delete\(\{ filter \}\)/s,
		);
	});

	it('still refuses to delete the whole table', async () => {
		await expect(store.delete({})).rejects.toThrow(/refusing to delete/);
	});
});

describe('SurrealDBVectorStore scores', () => {
	const row = (d: number) => ({
		id: new RecordId('documents', 'x'),
		content: 'c',
		metadata: {},
		__distance__: d,
	});

	it('returns a cosine similarity by default (higher is better)', async () => {
		const { client, store } = makeStore();
		client.rows = [[row(0.25)]];
		const [hit] = await store.similaritySearchVectorWithScore(
			[1, 0, 0, 0],
			1,
		);
		expect(hit?.[1]).toBeCloseTo(0.75);
	});

	it('maps unbounded metrics into (0, 1] and keeps the ordering', async () => {
		const { client, store } = makeStore({
			distanceStrategy: 'euclidean',
		});
		client.rows = [[row(0), row(1), row(3)]];
		const hits = await store.similaritySearchVectorWithScore(
			[1, 0, 0, 0],
			3,
		);
		const scores = hits.map((h) => h[1]);
		expect(scores).toEqual([1, 0.5, 0.25]);
		expect(scores[0]).toBeGreaterThan(scores[1] as number);
	});

	it('can still return raw distances when asked', async () => {
		const { client, store } = makeStore({ scoreMode: 'distance' });
		client.rows = [[row(0.25)]];
		const [hit] = await store.similaritySearchVectorWithScore(
			[1, 0, 0, 0],
			1,
		);
		expect(hit?.[1]).toBe(0.25);
	});

	it('omits the embedding from the projection for plain search', async () => {
		const { client, store } = makeStore();
		client.rows = [[]];
		await store.similaritySearchVectorWithScore([1, 0, 0, 0], 1);
		const { surql } = client.only();
		expect(surql).not.toContain('SELECT *');
		expect(surql).toContain('SELECT id, content, metadata,');
		expect(surql).not.toMatch(/SELECT[^,]*embedding/);
	});

	it('rejects a non-integer k rather than interpolating it', async () => {
		const { client, store } = makeStore();
		client.rows = [[]];
		await expect(
			store.similaritySearchVectorWithScore([1, 0, 0, 0], 1.5),
		).rejects.toThrow(/Invalid SurrealDB k/);
	});
});

describe('SurrealDBVectorStore MMR', () => {
	it('fetches embeddings and returns k diverse documents', async () => {
		const { client, store } = makeStore();
		const mk = (id: string, vec: number[], d: number) => ({
			id: new RecordId('documents', id),
			content: id,
			metadata: {},
			embedding: vec,
			__distance__: d,
		});
		// Two near-duplicates plus one distinct doc: MMR should not return
		// both near-duplicates when asked for 2.
		client.rows = [
			[
				mk('a', [1, 0, 0, 0], 0.0),
				mk('a2', [0.99, 0.01, 0, 0], 0.01),
				mk('b', [0, 1, 0, 0], 0.9),
			],
		];
		const docs = await store.maxMarginalRelevanceSearch('q', {
			k: 2,
			fetchK: 3,
			lambda: 0.5,
		});
		expect(docs).toHaveLength(2);
		// The property that matters: MMR picks the distinct document over the
		// near-duplicate, so 'a' and 'a2' never both appear.
		const picked = docs.map((d) => d.pageContent).sort();
		expect(picked).toContain('b');
		expect(picked).not.toEqual(['a', 'a2']);
		// And it had to ask for the embeddings to do that.
		expect(client.only().surql).toContain('embedding');
	});

	it('is exposed so asRetriever({ searchType: "mmr" }) works', () => {
		const { store } = makeStore();
		expect(typeof store.maxMarginalRelevanceSearch).toBe('function');
		expect(() => store.asRetriever({ searchType: 'mmr', k: 2 })).not.toThrow();
	});

	it('returns nothing when there is nothing to re-rank', async () => {
		const { client, store } = makeStore();
		client.rows = [[]];
		expect(await store.maxMarginalRelevanceSearch('q', { k: 2 })).toEqual(
			[],
		);
	});
});
