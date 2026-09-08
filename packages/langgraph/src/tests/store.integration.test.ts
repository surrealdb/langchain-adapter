import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealDBStore } from '../store.js';
import { makeConfig } from './helpers.js';

const cfg = makeConfig('store');
let store: SurrealDBStore;

beforeAll(async () => {
	store = new SurrealDBStore({ surreal: cfg });
	await store.start();
});

afterAll(async () => {
	await store?.stop();
});

describe('SurrealDBStore', () => {
	it('round-trips put → get', async () => {
		await store.put(['users', 'alice'], 'profile', {
			name: 'Alice',
			age: 30,
		});
		const item = await store.get(['users', 'alice'], 'profile');
		expect(item?.value).toEqual({ name: 'Alice', age: 30 });
		expect(item?.namespace).toEqual(['users', 'alice']);
		expect(item?.key).toBe('profile');
	});

	it('returns null for an unknown key', async () => {
		const item = await store.get(['users', 'nobody'], 'profile');
		expect(item).toBeNull();
	});

	it('search filters by namespace prefix and metadata', async () => {
		await store.put(['users', 'bob'], 'profile', {
			name: 'Bob',
			age: 25,
		});
		await store.put(['users', 'carol'], 'profile', {
			name: 'Carol',
			age: 40,
		});

		const all = await store.search(['users']);
		expect(all.length).toBeGreaterThanOrEqual(3);

		const adults = await store.search(['users'], {
			filter: { age: { $gte: 30 } },
		});
		const names = adults.map((i) => i.value.name).sort();
		expect(names).toEqual(['Alice', 'Carol']);
	});

	it('delete removes the row', async () => {
		await store.put(['tmp'], 'x', { v: 1 });
		await store.delete(['tmp'], 'x');
		expect(await store.get(['tmp'], 'x')).toBeNull();
	});

	it('listNamespaces returns distinct hierarchical paths', async () => {
		const ns = await store.listNamespaces({ prefix: ['users'] });
		const flat = ns.map((n) => n.join(':')).sort();
		expect(flat).toContain('users:alice');
		expect(flat).toContain('users:bob');
	});

	it('preserves order in batch results', async () => {
		const result = await store.batch([
			{ namespace: ['users', 'alice'], key: 'profile' },
			{
				namespace: ['users'],
				namespacePrefix: ['users'],
				limit: 1,
			} as any,
			{ matchConditions: [], limit: 100, offset: 0 } as any,
		]);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(3);
	});
});

/**
 * Deterministic toy embedder — character histogram, so overlap in the text
 * means proximity in the vector.
 */
class ToyEmbeddings {
	constructor(readonly dims = 16) {}
	async embedDocuments(texts: string[]) {
		return texts.map((t) => this.embed(t));
	}
	async embedQuery(text: string) {
		return this.embed(text);
	}
	private embed(text: string) {
		const v = new Array<number>(this.dims).fill(0);
		for (let i = 0; i < text.length; i++) {
			const slot = text.charCodeAt(i) % this.dims;
			v[slot] = (v[slot] ?? 0) + 1;
		}
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
		return v.map((x) => x / norm);
	}
}

describe('SurrealDBStore semantic search', () => {
	// This whole path — the HNSW index, embedding on put, KNN on search — was
	// previously never exercised by any test.
	async function seeded(extra: Record<string, unknown> = {}) {
		const store = new SurrealDBStore({
			surreal: makeConfig('storevec'),
			tableName: 'vecstore',
			index: { dims: 16, embeddings: new ToyEmbeddings(16) as never },
			...extra,
		});
		await store.start();
		await store.put(['docs'], 'a', { text: 'aaaa bbbb' });
		await store.put(['docs'], 'b', { text: 'zzzz yyyy' });
		return store;
	}

	it('ranks a semantic query and attaches scores', async () => {
		const store = await seeded();
		const hits = await store.search(['docs'], { query: 'aaaa bbbb' });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.key).toBe('a');
		expect(typeof hits[0]?.score).toBe('number');
		await store.stop();
	});

	it('combines a semantic query with a value filter', async () => {
		const store = await seeded();
		const hits = await store.search(['docs'], {
			query: 'aaaa bbbb',
			filter: { text: 'zzzz yyyy' },
		});
		expect(hits.map((h) => h.key)).toEqual(['b']);
		await store.stop();
	});

	it('honours limit and offset over the ranked results', async () => {
		const store = await seeded();
		const all = await store.search(['docs'], { query: 'aaaa bbbb' });
		const paged = await store.search(['docs'], {
			query: 'aaaa bbbb',
			limit: 1,
			offset: 1,
		});
		expect(paged).toHaveLength(1);
		expect(paged[0]?.key).toBe(all[1]?.key);
		await store.stop();
	});

	it('supports $in through the shared filter translator', async () => {
		// The hand-rolled filter loop this replaced threw on $in.
		const store = await seeded();
		const hits = await store.search(['docs'], {
			filter: { text: { $in: ['aaaa bbbb'] } },
		});
		expect(hits.map((h) => h.key)).toEqual(['a']);
		await store.stop();
	});

	it('refuses a semantic query with no index when strict', async () => {
		const store = new SurrealDBStore({
			surreal: makeConfig('storenoidx'),
			tableName: 'noidx',
			strictSearch: true,
		});
		await store.start();
		await store.put(['docs'], 'a', { text: 'x' });
		await expect(
			store.search(['docs'], { query: 'anything' }),
		).rejects.toThrow(/no `index` is configured/);
		await store.stop();
	});
});

describe('SurrealDBStore.listNamespaces', () => {
	it('returns each namespace once, however many keys it holds', async () => {
		// One row per item, so without deduping `users/alice` came back three
		// times. The old test used `toContain` and missed it.
		const store = new SurrealDBStore({
			surreal: makeConfig('storens'),
			tableName: 'nsstore',
		});
		await store.start();
		await store.put(['users', 'alice'], 'k1', { v: 1 });
		await store.put(['users', 'alice'], 'k2', { v: 2 });
		await store.put(['users', 'alice'], 'k3', { v: 3 });
		await store.put(['users', 'bob'], 'k1', { v: 4 });

		const namespaces = await store.listNamespaces({ prefix: ['users'] });
		expect(namespaces).toEqual([
			['users', 'alice'],
			['users', 'bob'],
		]);
		await store.stop();
	});

	it('dedupes after trimming to maxDepth too', async () => {
		const store = new SurrealDBStore({
			surreal: makeConfig('storens2'),
			tableName: 'nsstore2',
		});
		await store.start();
		await store.put(['a', 'b', 'c'], 'k1', { v: 1 });
		await store.put(['a', 'b', 'd'], 'k2', { v: 2 });
		expect(await store.listNamespaces({ maxDepth: 2 })).toEqual([
			['a', 'b'],
		]);
		await store.stop();
	});
});
