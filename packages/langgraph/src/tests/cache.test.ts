import type { CacheFullKey } from '@langchain/langgraph-checkpoint';
import { RecordId } from '@surrealdb/langchain-core';
import { describe, expect, it, vi } from 'vitest';
import { SurrealDBNodeCache } from '../cache.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make(onError?: (e: unknown) => void) {
	const client = new FakeSurrealDBClient();
	const cache = new SurrealDBNodeCache({
		surreal: client,
		skipInitSchema: true,
		skipVersionCheck: true,
		...(onError ? { onError } : {}),
	});
	return { client, cache };
}

const KEY: CacheFullKey = [['__pregel_ns', 'my node'], 'abc123'];

describe('SurrealDBNodeCache.set', () => {
	it('treats ttl as seconds, per the CachePolicy contract', async () => {
		const { client, cache } = make();
		const before = Date.now();
		await cache.set([{ key: KEY, value: 1, ttl: 120 }]);
		const rows = client.only().bindings?.rows as {
			expires_at: Date;
		}[];
		expect(rows[0]?.expires_at.getTime()).toBeGreaterThanOrEqual(
			before + 120_000,
		);
		expect(rows[0]?.expires_at.getTime()).toBeLessThan(before + 121_000);
	});

	it('stores no expiry when no ttl is given', async () => {
		// Omitted, not null — SurrealDB's `option<datetime>` rejects NULL.
		const { client, cache } = make();
		await cache.set([{ key: KEY, value: 1 }]);
		const rows = client.only().bindings?.rows as Record<string, unknown>[];
		expect(rows[0]).not.toHaveProperty('expires_at');
	});

	it('uses an array record id, never a joined string', async () => {
		// The namespace carries a user-chosen node name.
		const { client, cache } = make();
		await cache.set([{ key: KEY, value: 1 }]);
		const rows = client.only().bindings?.rows as { id: RecordId }[];
		expect(rows[0]?.id).toBeInstanceOf(RecordId);
		expect(rows[0]?.id.id).toEqual([['__pregel_ns', 'my node'], 'abc123']);
	});

	it('reports write failures instead of rejecting', async () => {
		// The pregel loop calls set() without awaiting, so a rejection here
		// would surface as an unhandled rejection.
		const onError = vi.fn();
		const { client, cache } = make(onError);
		client.execute = () => Promise.reject(new Error('boom'));
		await expect(
			cache.set([{ key: KEY, value: 1 }]),
		).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledOnce();
	});

	it('short-circuits an empty write', async () => {
		const { client, cache } = make();
		await cache.set([]);
		expect(client.queries).toHaveLength(0);
	});
});

describe('SurrealDBNodeCache.get', () => {
	it('omits misses rather than returning holes', async () => {
		const { client, cache } = make();
		client.rows = [[]];
		expect(await cache.get([KEY])).toEqual([]);
	});

	it('returns the caller’s own key tuple, not a rebuilt one', async () => {
		// The pregel loop re-serialises the returned key to find its task.
		const { client, cache } = make();
		const [enc, val] = await cache.serde.dumpsTyped({ n: 1 });
		client.rows = [
			[{ ns: ['__pregel_ns', 'my node'], key: 'abc123', enc, val }],
		];
		const got = await cache.get([KEY]);
		expect(got).toHaveLength(1);
		expect(got[0]?.key).toBe(KEY);
		expect(got[0]?.value).toEqual({ n: 1 });
	});

	it('never serves an expired row', async () => {
		const { client, cache } = make();
		client.rows = [[]];
		await cache.get([KEY]);
		expect(client.only().surql).toContain(
			'expires_at IS NONE OR expires_at > time::now()',
		);
	});

	it('short-circuits an empty read', async () => {
		const { client, cache } = make();
		expect(await cache.get([])).toEqual([]);
		expect(client.queries).toHaveLength(0);
	});
});

describe('SurrealDBNodeCache.clear', () => {
	it('clears everything when given an empty list', async () => {
		// An empty array means "all namespaces", per the BaseCache contract.
		const { client, cache } = make();
		await cache.clear([]);
		const { surql } = client.only();
		expect(surql).toContain('DELETE FROM type::table($table)');
		expect(surql).not.toContain('WHERE');
	});

	it('scopes the delete when given namespaces', async () => {
		const { client, cache } = make();
		await cache.clear([['a'], ['b']]);
		expect(client.queries).toHaveLength(2);
		expect(client.queries[0]?.surql).toContain('WHERE ns = $ns');
		expect(client.queries[0]?.bindings?.ns).toEqual(['a']);
		expect(client.queries[1]?.bindings?.ns).toEqual(['b']);
	});
});
