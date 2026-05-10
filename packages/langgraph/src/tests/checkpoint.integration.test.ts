import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { CheckpointSaver } from '../checkpoint.js';
import { makeConfig } from './helpers.js';

const cfg = makeConfig('cp');
let saver: CheckpointSaver;

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
	saver = new CheckpointSaver({ surreal: cfg });
	await saver.setup();
});

afterAll(async () => {
	await saver?.close();
});

describe('CheckpointSaver', () => {
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
