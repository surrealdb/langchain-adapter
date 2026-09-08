import { AIMessage } from '@langchain/core/messages';
import type { Generation } from '@langchain/core/outputs';
import { RecordId } from '@surrealdb/langchain-core';
import { describe, expect, it } from 'vitest';
import { SurrealDBLLMCache } from '../caches/surrealdb.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make(args: Partial<{ ttlSeconds: number; storePrompt: boolean }> = {}) {
	const client = new FakeSurrealDBClient();
	const cache = new SurrealDBLLMCache({
		surreal: client,
		skipInitSchema: true,
		skipVersionCheck: true,
		...args,
	});
	return { client, cache };
}

const gen: Generation[] = [
	{ text: 'hello', generationInfo: { finish_reason: 'stop' } },
];

describe('SurrealDBLLMCache', () => {
	it('keys rows by the hashed (prompt, llmKey) pair', async () => {
		const { client, cache } = make();
		await cache.update('p', 'k', gen);
		const id = client.only().bindings?.id as RecordId;
		expect(id).toBeInstanceOf(RecordId);
		// sha256 hex — safe as a bare record id.
		expect(id.id).toMatch(/^[0-9a-f]{64}$/);
	});

	it('gives different prompts different keys', async () => {
		const { client, cache } = make();
		await cache.update('p1', 'k', gen);
		await cache.update('p2', 'k', gen);
		const [a, b] = client.queries.map(
			(q) => (q.bindings?.id as RecordId).id,
		);
		expect(a).not.toBe(b);
	});

	it('round-trips generations through lookup', async () => {
		const { client, cache } = make();
		await cache.update('p', 'k', gen);
		const stored = (client.only().bindings?.row as { generations: string })
			.generations;

		client.queries.length = 0;
		client.rows = [[{ generations: stored }]];
		const got = await cache.lookup('p', 'k');
		expect(got?.[0]?.text).toBe('hello');
	});

	it('round-trips an AI message with tool calls', async () => {
		const { client, cache } = make();
		const message = new AIMessage({
			content: 'calling',
			tool_calls: [{ name: 'get', args: { q: 1 }, id: 't1' }],
		});
		await cache.update('p', 'k', [{ text: 'calling', message } as never]);
		const stored = (client.only().bindings?.row as { generations: string })
			.generations;

		client.queries.length = 0;
		client.rows = [[{ generations: stored }]];
		const got = await cache.lookup('p', 'k');
		const back = (got?.[0] as { message?: AIMessage }).message;
		expect(back?.tool_calls?.[0]).toMatchObject({ name: 'get', id: 't1' });
	});

	it('returns null on a miss', async () => {
		const { client, cache } = make();
		client.rows = [[]];
		expect(await cache.lookup('p', 'k')).toBeNull();
	});

	it('never serves an expired row', async () => {
		const { client, cache } = make();
		client.rows = [[]];
		await cache.lookup('p', 'k');
		expect(client.only().surql).toContain(
			'expires_at IS NONE OR expires_at > time::now()',
		);
	});

	it('translates ttlSeconds into an absolute expiry', async () => {
		const { client, cache } = make({ ttlSeconds: 60 });
		const before = Date.now();
		await cache.update('p', 'k', gen);
		const row = client.only().bindings?.row as { expires_at: Date };
		expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + 60_000);
		expect(row.expires_at.getTime()).toBeLessThan(before + 61_000);
	});

	it('stores no expiry when no ttl is configured', async () => {
		// Omitted, not null — SurrealDB's `option<datetime>` rejects NULL.
		const { client, cache } = make();
		await cache.update('p', 'k', gen);
		expect(client.only().bindings?.row).not.toHaveProperty('expires_at');
	});

	it('does not persist the prompt by default', async () => {
		const { client, cache } = make();
		await cache.update('secret prompt', 'k', gen);
		expect(client.only().bindings?.row).not.toHaveProperty('prompt');
	});

	it('persists the prompt when explicitly opted in', async () => {
		const { client, cache } = make({ storePrompt: true });
		await cache.update('secret prompt', 'k', gen);
		expect(
			(client.only().bindings?.row as { prompt: unknown }).prompt,
		).toBe('secret prompt');
	});

	it('honours a custom key encoder', async () => {
		const { client, cache } = make();
		cache.makeDefaultKeyEncoder(() => 'fixedkey');
		await cache.update('p', 'k', gen);
		expect((client.only().bindings?.id as RecordId).id).toBe('fixedkey');
	});
});
