import { beforeEach, describe, expect, it } from 'vitest';
import { SurrealDBRecordManager } from '../indexes/record_manager.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make() {
	const client = new FakeSurrealDBClient();
	const manager = new SurrealDBRecordManager({
		surreal: client,
		namespace: 'ns1',
		skipInitSchema: true,
		skipVersionCheck: true,
	});
	return { client, manager };
}

/** getTime() issues a query first; queue its row ahead of the real one. */
const NOW = 1_700_000_000_000_000; // epoch micros

describe('SurrealDBRecordManager.getTime', () => {
	it('reads the clock from the server, not the process', async () => {
		const { client, manager } = make();
		client.rows = [[NOW]];
		expect(await manager.getTime()).toBe(NOW);
		expect(client.only().surql).toContain('time::micros(time::now())');
	});

	it('fails loudly if the server returns something else', async () => {
		const { client, manager } = make();
		client.rows = [[]];
		await expect(manager.getTime()).rejects.toThrow(/expected a number/);
	});
});

describe('SurrealDBRecordManager.update', () => {
	it('rejects a groupIds list that does not line up with keys', async () => {
		const { manager } = make();
		await expect(
			manager.update(['a', 'b'], { groupIds: ['g'] }),
		).rejects.toThrow(/groupIds length \(1\).*keys length \(2\)/);
	});

	it('refuses to write timestamps behind timeAtLeast', async () => {
		const { client, manager } = make();
		client.rows = [[NOW]];
		await expect(
			manager.update(['a'], { timeAtLeast: NOW + 1000 }),
		).rejects.toThrow(/clock skew/);
	});

	it('upserts, stamping the server time on every key', async () => {
		const { client, manager } = make();
		client.rows = [[NOW]];
		await manager.update(['a', 'b'], { groupIds: ['g1', null] });
		const write = client.last();
		expect(write.surql).toContain('ON DUPLICATE KEY UPDATE');
		const rows = write.bindings?.rows as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			namespace: 'ns1',
			key: 'a',
			group_id: 'g1',
			updated_at: NOW,
		});
		// Omitted, not null: SurrealDB's `option<string>` rejects an explicit
		// NULL, so a nullish optional has to be left out of the row.
		expect(rows[1]).not.toHaveProperty('group_id');
	});

	it('does nothing for an empty key list', async () => {
		const { client, manager } = make();
		await manager.update([]);
		expect(client.queries).toHaveLength(0);
	});
});

describe('SurrealDBRecordManager.exists', () => {
	it('returns results in input order, not query order', async () => {
		const { client, manager } = make();
		// Server returns only the hits, in its own order.
		client.rows = [['c', 'a']];
		expect(await manager.exists(['a', 'b', 'c'])).toEqual([
			true,
			false,
			true,
		]);
	});

	it('short-circuits an empty list', async () => {
		const { client, manager } = make();
		expect(await manager.exists([])).toEqual([]);
		expect(client.queries).toHaveLength(0);
	});
});

describe('SurrealDBRecordManager.listKeys', () => {
	let client: FakeSurrealDBClient;
	let manager: SurrealDBRecordManager;
	beforeEach(() => {
		({ client, manager } = make());
		client.rows = [[]];
	});

	it('always scopes to its namespace', async () => {
		await manager.listKeys();
		expect(client.only().surql).toContain('namespace = $ns');
		expect(client.only().bindings?.ns).toBe('ns1');
	});

	it('applies before/after bounds', async () => {
		await manager.listKeys({ before: 5, after: 1 });
		const { surql, bindings } = client.only();
		expect(surql).toContain('updated_at < $before');
		expect(surql).toContain('updated_at > $after');
		expect(bindings).toMatchObject({ before: 5, after: 1 });
	});

	it('keeps null groupIds reachable via an IS NONE disjunct', async () => {
		// `INSIDE` never matches NONE, so without this the null-group rows
		// would be silently dropped.
		await manager.listKeys({ groupIds: ['g1', null] });
		const { surql, bindings } = client.only();
		expect(surql).toContain('group_id INSIDE $groupIds');
		expect(surql).toContain('group_id IS NONE');
		expect(bindings?.groupIds).toEqual(['g1']);
	});

	it('omits the INSIDE clause when every groupId is null', async () => {
		await manager.listKeys({ groupIds: [null] });
		const { surql } = client.only();
		expect(surql).toContain('group_id IS NONE');
		expect(surql).not.toContain('INSIDE');
	});

	it('validates limit rather than interpolating it', async () => {
		await expect(manager.listKeys({ limit: -1 })).rejects.toThrow(
			/Invalid SurrealDB limit/,
		);
	});
});

describe('SurrealDBRecordManager.deleteKeys', () => {
	it('scopes the delete to namespace and keys', async () => {
		const { client, manager } = make();
		await manager.deleteKeys(['a', 'b']);
		const { surql, bindings } = client.only();
		expect(surql).toContain('namespace = $ns AND key INSIDE $keys');
		expect(bindings?.keys).toEqual(['a', 'b']);
	});

	it('does nothing for an empty list', async () => {
		const { client, manager } = make();
		await manager.deleteKeys([]);
		expect(client.queries).toHaveLength(0);
	});
});
