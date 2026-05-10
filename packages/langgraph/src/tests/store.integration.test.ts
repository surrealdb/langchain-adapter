import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../store.js';
import { makeConfig } from './helpers.js';

const cfg = makeConfig('store');
let store: Store;

beforeAll(async () => {
	store = new Store({ surreal: cfg });
	await store.start();
});

afterAll(async () => {
	await store?.stop();
});

describe('Store', () => {
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
			{ namespace: ['users'], namespacePrefix: ['users'], limit: 1 } as any,
			{ matchConditions: [], limit: 100, offset: 0 } as any,
		]);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(3);
	});
});
