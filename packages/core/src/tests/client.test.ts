import { describe, expect, it } from 'vitest';
import { resolveClient, SurrealDBClient } from '../client.js';

describe('SurrealDBClient.connect', () => {
	it('rejects a config that is neither url+credentials nor url+token', async () => {
		// Previously this fell through, marked the client connected, and left
		// it unauthenticated — the failure surfaced on the first query.
		const client = new SurrealDBClient({
			url: 'ws://localhost:8000',
		} as never);
		await expect(client.connect()).rejects.toThrow(
			/username, password.*token|Expected/,
		);
	});

	it('names the keys it did receive, to make the mistake obvious', async () => {
		const client = new SurrealDBClient({
			url: 'ws://localhost:8000',
			user: 'root',
		} as never);
		await expect(client.connect()).rejects.toThrow(/url, user/);
	});

	it('does not mark itself connected after a rejected config', async () => {
		const client = new SurrealDBClient({ url: 'ws://x' } as never);
		await expect(client.connect()).rejects.toThrow();
		// A second call must fail the same way rather than silently no-op.
		await expect(client.connect()).rejects.toThrow();
	});
});

describe('resolveClient', () => {
	it('passes an existing client through and disclaims ownership', () => {
		const existing = new SurrealDBClient({
			url: 'ws://localhost:8000',
			username: 'root',
			password: 'root',
		});
		expect(resolveClient(existing)).toEqual({
			client: existing,
			owned: false,
		});
	});

	it('builds and owns a client when given a config', () => {
		const { client, owned } = resolveClient({
			url: 'ws://localhost:8000',
			username: 'root',
			password: 'root',
			namespace: 'ns',
			database: 'db',
		});
		expect(client).toBeInstanceOf(SurrealDBClient);
		expect(owned).toBe(true);
		expect(client.namespace).toBe('ns');
		expect(client.database).toBe('db');
	});
});
