import type {
	Checkpoint,
	CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealDBSaver } from '../checkpoint.js';
import { makeConfig } from './helpers.js';

const cfg = makeConfig('cp');
let saver: SurrealDBSaver;

function emptyCheckpoint(id: string): Checkpoint {
	return {
		v: 4,
		id,
		ts: new Date().toISOString(),
		channel_values: {},
		channel_versions: {},
		versions_seen: {},
	};
}

const meta: CheckpointMetadata = { source: 'input', step: -1, parents: {} };

beforeAll(async () => {
	saver = new SurrealDBSaver({ surreal: cfg });
	await saver.setup();
});

afterAll(async () => {
	await saver?.close();
});

describe('SurrealDBSaver', () => {
	const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };

	it('returns undefined for an unknown thread', async () => {
		const tuple = await saver.getTuple({
			configurable: { thread_id: 'no-such-thread' },
		});
		expect(tuple).toBeUndefined();
	});

	it('round-trips put → getTuple', async () => {
		const cp = emptyCheckpoint('01HZ7JCW0000000000000A');
		cp.channel_values = { greeting: 'hi' };
		cp.channel_versions = { greeting: 1 };

		const newCfg = await saver.put(config, cp, meta, {});
		expect(newCfg.configurable?.checkpoint_id).toBe(cp.id);

		const tuple = await saver.getTuple(newCfg);
		expect(tuple).toBeDefined();
		expect(tuple?.checkpoint.id).toBe(cp.id);
		expect(tuple?.checkpoint.channel_values).toEqual({ greeting: 'hi' });
		expect(tuple?.metadata?.source).toBe('input');
	});

	it('list yields tuples in reverse-time order', async () => {
		const ids = [
			'01HZ7JCW0000000000000B',
			'01HZ7JCW0000000000000C',
			'01HZ7JCW0000000000000D',
		];
		for (const id of ids) {
			await saver.put(config, emptyCheckpoint(id), meta, {});
		}
		const tuples: string[] = [];
		for await (const t of saver.list(config, { limit: 3 })) {
			tuples.push(t.checkpoint.id);
		}
		// Latest written sorts highest by id.
		expect(tuples[0]).toBe('01HZ7JCW0000000000000D');
	});

	it('putWrites surfaces pendingWrites on next getTuple', async () => {
		const cp = emptyCheckpoint('01HZ7JCW0000000000000E');
		const cfg2 = await saver.put(config, cp, meta, {});

		await saver.putWrites(
			cfg2,
			[
				['greeting', 'hello'],
				['count', 1],
			],
			'task-1',
		);

		const tuple = await saver.getTuple(cfg2);
		const channels = tuple?.pendingWrites?.map((w) => w[1]) ?? [];
		expect(channels).toContain('greeting');
		expect(channels).toContain('count');
	});

	it('deleteThread removes both checkpoints and writes', async () => {
		await saver.deleteThread('t1');
		const tuple = await saver.getTuple({
			configurable: { thread_id: 't1' },
		});
		expect(tuple).toBeUndefined();
	});
});

describe('SurrealDBSaver.list against a live server', () => {
	async function seed(saver: SurrealDBSaver, threadId: string, ns: string) {
		const config = {
			configurable: { thread_id: threadId, checkpoint_ns: ns },
		};
		const cp = emptyCheckpoint(`${threadId}-${ns}-1`);
		const saved = await saver.put(
			config,
			cp,
			{ source: 'loop', step: 1, parents: {} },
			{},
		);
		return saved;
	}

	it('lists across every thread when no thread_id is given', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('list_all') });
		await seed(saver, 'tA', '');
		await seed(saver, 'tB', '');

		const seen: string[] = [];
		for await (const t of saver.list({ configurable: {} })) {
			seen.push(t.config.configurable?.thread_id as string);
		}
		expect(seen.sort()).toEqual(['tA', 'tB']);
		await saver.close();
	});

	it('does not pin to the root namespace when none is given', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('list_ns') });
		await seed(saver, 't1', '');
		await seed(saver, 't1', 'child');

		const namespaces: string[] = [];
		for await (const t of saver.list({
			configurable: { thread_id: 't1' },
		})) {
			namespaces.push(t.config.configurable?.checkpoint_ns as string);
		}
		expect(namespaces.sort()).toEqual(['', 'child']);
		await saver.close();
	});

	it('populates pendingWrites so getStateHistory sees pending tasks', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('list_pw') });
		const saved = await seed(saver, 't1', '');
		await saver.putWrites(saved, [['messages', 'hello']], 'task1');

		const tuples = [];
		for await (const t of saver.list({
			configurable: { thread_id: 't1' },
		})) {
			tuples.push(t);
		}
		expect(tuples[0]?.pendingWrites).toEqual([
			['task1', 'messages', 'hello'],
		]);
		await saver.close();
	});

	it('filters on a metadata key', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('list_filt') });
		const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };
		await saver.put(
			config,
			emptyCheckpoint('c1'),
			{ source: 'input', step: 0, parents: {} },
			{},
		);
		await saver.put(
			config,
			emptyCheckpoint('c2'),
			{ source: 'loop', step: 1, parents: {} },
			{},
		);

		const sources = [];
		for await (const t of saver.list(config, {
			filter: { source: 'input' },
		})) {
			sources.push(t.metadata?.source);
		}
		expect(sources).toEqual(['input']);
		await saver.close();
	});

	it('returns nothing for a hostile filter key rather than injecting', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('list_inj') });
		const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };
		await saver.put(
			config,
			emptyCheckpoint('c1'),
			{ source: 'loop', step: 1, parents: {} },
			{},
		);
		const seen = [];
		for await (const t of saver.list(config, {
			filter: { 'x = 1 OR true': 1 },
		})) {
			seen.push(t);
		}
		expect(seen).toEqual([]);
		await saver.close();
	});
});

describe('SurrealDBSaver.putWrites conflict policy against a live server', () => {
	it('overwrites an interrupt but leaves a replayed regular write alone', async () => {
		const saver = new SurrealDBSaver({ surreal: makeConfig('pw_policy') });
		const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };
		const saved = await saver.put(
			config,
			emptyCheckpoint('c1'),
			{ source: 'loop', step: 1, parents: {} },
			{},
		);

		await saver.putWrites(saved, [['messages', 'first']], 'task1');
		await saver.putWrites(saved, [['messages', 'second']], 'task1');
		await saver.putWrites(saved, [['__interrupt__', 'stale']], 'task1');
		await saver.putWrites(saved, [['__interrupt__', 'fresh']], 'task1');

		const tuple = await saver.getTuple(saved);
		const writes = Object.fromEntries(
			(tuple?.pendingWrites ?? []).map(([, channel, value]) => [
				channel,
				value,
			]),
		);
		// A replayed task must not clobber what the first attempt recorded…
		expect(writes.messages).toBe('first');
		// …but an interrupt resumed twice must not keep the stale payload.
		expect(writes.__interrupt__).toBe('fresh');
		await saver.close();
	});
});
