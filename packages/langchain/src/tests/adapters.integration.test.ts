import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Generation } from '@langchain/core/outputs';
import { afterAll, describe, expect, it } from 'vitest';
import { SurrealDBLLMCache } from '../caches/surrealdb.js';
import { SurrealDBChatMessageHistory } from '../chat_history/surrealdb.js';
import { SurrealDBVectorStore } from '../vectorstores/surrealdb.js';
import { FakeEmbeddings, makeConfig } from './helpers.js';

describe('SurrealDBLLMCache', () => {
	const cache = new SurrealDBLLMCache({ surreal: makeConfig('llmcache') });
	afterAll(() => cache.close());

	const gen: Generation[] = [{ text: 'cached answer' }];

	it('round-trips generations through the database', async () => {
		expect(await cache.lookup('prompt', 'llm')).toBeNull();
		await cache.update('prompt', 'llm', gen);
		expect((await cache.lookup('prompt', 'llm'))?.[0]?.text).toBe(
			'cached answer',
		);
	});

	it('keeps different prompts apart', async () => {
		await cache.update('other', 'llm', [{ text: 'other answer' }]);
		expect((await cache.lookup('prompt', 'llm'))?.[0]?.text).toBe(
			'cached answer',
		);
	});

	it('stops serving an entry once its ttl has elapsed', async () => {
		const ttlCache = new SurrealDBLLMCache({
			surreal: makeConfig('llmcache_ttl'),
			ttlSeconds: -1, // already expired
		});
		await ttlCache.update('p', 'k', gen);
		expect(await ttlCache.lookup('p', 'k')).toBeNull();
		await ttlCache.close();
	});
});

describe('SurrealDBChatMessageHistory', () => {
	const config = makeConfig('chathist');
	const history = new SurrealDBChatMessageHistory({
		surreal: config,
		sessionId: 's1',
	});
	afterAll(() => history.close());

	it('round-trips a conversation in order', async () => {
		await history.addMessages([
			new HumanMessage('first'),
			new AIMessage('second'),
		]);
		await history.addMessage(new HumanMessage('third'));

		const messages = await history.getMessages();
		expect(messages.map((m) => m.text)).toEqual([
			'first',
			'second',
			'third',
		]);
		expect(messages.map((m) => m.getType())).toEqual([
			'human',
			'ai',
			'human',
		]);
	});

	it('preserves tool calls across the round trip', async () => {
		const h = new SurrealDBChatMessageHistory({
			surreal: config,
			sessionId: 'tools',
		});
		await h.addMessage(
			new AIMessage({
				content: '',
				tool_calls: [{ name: 'search', args: { q: 'x' }, id: 't1' }],
			}),
		);
		const [back] = await h.getMessages();
		expect((back as AIMessage).tool_calls?.[0]).toMatchObject({
			name: 'search',
			id: 't1',
		});
		await h.close();
	});

	it('keeps sessions isolated', async () => {
		const other = new SurrealDBChatMessageHistory({
			surreal: config,
			sessionId: 's2',
		});
		expect(await other.getMessages()).toEqual([]);
		await other.close();
	});

	it('clears only its own session', async () => {
		const other = new SurrealDBChatMessageHistory({
			surreal: config,
			sessionId: 's3',
		});
		await other.addMessage(new HumanMessage('temp'));
		await other.clear();
		expect(await other.getMessages()).toEqual([]);
		expect(await history.getMessages()).toHaveLength(3);
		await other.close();
	});
});

describe('SurrealDBVectorStore against a live server', () => {
	it('round-trips custom ids and deletes by them', async () => {
		const store = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{
				surreal: makeConfig('vsids'),
				dimensions: 16,
				tableName: 'iddocs',
			},
		);
		const ids = await store.addDocuments(
			[
				{ pageContent: 'plain', metadata: {} },
				{ pageContent: 'spaced', metadata: {} },
				{ pageContent: 'coloned', metadata: {} },
			],
			{ ids: ['plain', 'has space', 'dash-ed-uuid-0000'] },
		);
		expect(ids).toEqual(['plain', 'has space', 'dash-ed-uuid-0000']);

		// Ids come back exactly as supplied, never doubly prefixed.
		const found = await store.similaritySearch('plain', 10);
		expect(found.map((d) => d.id).sort()).toEqual([
			'dash-ed-uuid-0000',
			'has space',
			'plain',
		]);

		// The delete that used to silently remove nothing.
		await store.delete({ ids: ['has space'] });
		const after = await store.similaritySearch('plain', 10);
		expect(after.map((d) => d.id).sort()).toEqual([
			'dash-ed-uuid-0000',
			'plain',
		]);
		await store.close();
	});

	it('returns similarity scores, highest first', async () => {
		const store = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{
				surreal: makeConfig('vsscore'),
				dimensions: 16,
				tableName: 'scoredocs',
			},
		);
		await store.addDocuments([
			{ pageContent: 'alpha alpha alpha', metadata: {} },
			{ pageContent: 'zzzzzz', metadata: {} },
		]);
		const hits = await store.similaritySearchWithScore('alpha alpha', 2);
		expect(hits).toHaveLength(2);
		// Higher is better, so the first hit outscores the second.
		expect(hits[0]?.[1]).toBeGreaterThan(hits[1]?.[1] as number);
		expect(hits[0]?.[1]).toBeLessThanOrEqual(1);
		await store.close();
	});

	it('uses the HNSW index and still applies a metadata filter', async () => {
		const store = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{
				surreal: makeConfig('vsfilter'),
				dimensions: 16,
				tableName: 'filterdocs',
			},
		);
		await store.addDocuments([
			{ pageContent: 'alpha', metadata: { topic: 'a' } },
			{ pageContent: 'alpha', metadata: { topic: 'b' } },
		]);
		const hits = await store.similaritySearch('alpha', 5, { topic: 'b' });
		expect(hits).toHaveLength(1);
		expect(hits[0]?.metadata.topic).toBe('b');
		await store.close();
	});

	it('supports maximal marginal relevance', async () => {
		const store = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{
				surreal: makeConfig('vsmmr'),
				dimensions: 16,
				tableName: 'mmrdocs',
			},
		);
		await store.addDocuments([
			{ pageContent: 'alpha one', metadata: {} },
			{ pageContent: 'alpha two', metadata: {} },
			{ pageContent: 'zzz distinct', metadata: {} },
		]);
		const docs = await store.maxMarginalRelevanceSearch('alpha', {
			k: 2,
			fetchK: 3,
			lambda: 0.5,
		});
		expect(docs).toHaveLength(2);
		await store.close();
	});

	it('works through asRetriever with searchType mmr', async () => {
		const store = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{
				surreal: makeConfig('vsret'),
				dimensions: 16,
				tableName: 'retdocs',
			},
		);
		await store.addDocuments([
			{ pageContent: 'alpha', metadata: {} },
			{ pageContent: 'beta', metadata: {} },
		]);
		const retriever = store.asRetriever({ searchType: 'mmr', k: 1 });
		expect(await retriever.invoke('alpha')).toHaveLength(1);
		await store.close();
	});
});

describe('SurrealDBVectorStore index modes', () => {
	// `hnsw` and `diskann` use `<|k,EF|>`; `none` falls back to the
	// brute-force `<|k,METRIC|>`. Getting the spelling wrong per mode fails
	// in three different ways on SurrealDB v3, one of them silently.
	it.each(['hnsw', 'diskann', 'none'] as const)(
		'ranks, filters and re-ranks with indexType %s',
		async (indexType) => {
			const store = await SurrealDBVectorStore.initialize(
				new FakeEmbeddings(16),
				{
					surreal: makeConfig(`idx_${indexType}`),
					dimensions: 16,
					tableName: 'idxdocs',
					indexType,
				},
			);
			await store.addDocuments([
				{ pageContent: 'alpha alpha', metadata: { t: 'a' } },
				{ pageContent: 'zzzz yyyy', metadata: { t: 'b' } },
			]);

			const plain = await store.similaritySearch('alpha alpha', 2);
			expect(plain[0]?.pageContent).toBe('alpha alpha');

			const filtered = await store.similaritySearch('alpha alpha', 2, {
				t: 'b',
			});
			expect(filtered.map((d) => d.metadata.t)).toEqual(['b']);

			expect(
				await store.maxMarginalRelevanceSearch('alpha', {
					k: 1,
					fetchK: 2,
				}),
			).toHaveLength(1);

			await store.close();
		},
	);
});

