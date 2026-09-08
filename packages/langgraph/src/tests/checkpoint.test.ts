import type { RunnableConfig } from '@langchain/core/runnables';
import {
	type Checkpoint,
	emptyCheckpoint,
	WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';
import { SurrealDBSaver } from '../checkpoint.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make() {
	const client = new FakeSurrealDBClient();
	const saver = new SurrealDBSaver({
		surreal: client,
		skipInitSchema: true,
		skipVersionCheck: true,
	});
	return { client, saver };
}

/** The WHERE clause only, so ORDER BY mentions don't confuse assertions. */
function whereOf(surql: string): string {
	const m = /WHERE (.*?) ORDER BY/.exec(surql);
	return m?.[1] ?? '';
}

async function listQueryFor(config: RunnableConfig, options?: object) {
	const { client, saver } = make();
	client.rows = [[]];
	// biome-ignore lint/correctness/noUnusedVariables: draining the generator
	for await (const _ of saver.list(config, options as never)) {
	}
	return client.only();
}

describe('SurrealDBSaver.list scoping', () => {
	it('lists across every thread when no thread_id is given', async () => {
		// MemorySaver iterates all threads here; requiring thread_id made
		// `list({ configurable: {} })` silently return nothing.
		const { surql } = await listQueryFor({ configurable: {} });
		expect(surql).not.toContain('thread_id = $tid');
		expect(surql).not.toContain('WHERE');
	});

	it('does not pin to the root namespace when checkpoint_ns is absent', async () => {
		const { surql, bindings } = await listQueryFor({
			configurable: { thread_id: 't1' },
		});
		expect(surql).toContain('thread_id = $tid');
		// It still appears in ORDER BY — what matters is that it does not
		// constrain the rows.
		expect(whereOf(surql)).not.toContain('checkpoint_ns');
		expect(bindings?.tid).toBe('t1');
	});

	it('filters the namespace when one is supplied, including ""', async () => {
		const { surql, bindings } = await listQueryFor({
			configurable: { thread_id: 't1', checkpoint_ns: '' },
		});
		expect(surql).toContain('checkpoint_ns = $ns');
		expect(bindings?.ns).toBe('');
	});

	it('honours checkpoint_id as an exact filter', async () => {
		const { surql, bindings } = await listQueryFor({
			configurable: { thread_id: 't1', checkpoint_id: 'c9' },
		});
		expect(surql).toContain('checkpoint_id = $cid');
		expect(bindings?.cid).toBe('c9');
	});

	it('applies before as a strict upper bound', async () => {
		const { surql, bindings } = await listQueryFor(
			{ configurable: { thread_id: 't1' } },
			{ before: { configurable: { checkpoint_id: 'c5' } } },
		);
		expect(surql).toContain('checkpoint_id < $beforeId');
		expect(bindings?.beforeId).toBe('c5');
	});

	it('escapes a hostile metadata filter key', async () => {
		const { surql } = await listQueryFor(
			{ configurable: { thread_id: 't1' } },
			{ filter: { 'x = 1 OR true': 1 } },
		);
		expect(surql).toContain('metadata.⟨x = 1 OR true⟩');
	});

	it('validates limit instead of interpolating it', async () => {
		const { saver } = make();
		await expect(async () => {
			for await (const _ of saver.list(
				{ configurable: { thread_id: 't' } },
				{ limit: 1.5 },
			)) {
				// drain
			}
		}).rejects.toThrow(/Invalid SurrealDB limit/);
	});

	it('orders by thread, namespace, then checkpoint descending', async () => {
		const { surql } = await listQueryFor({ configurable: {} });
		expect(surql).toContain(
			'ORDER BY thread_id ASC, checkpoint_ns ASC, checkpoint_id DESC',
		);
	});
});

describe('SurrealDBSaver.list results', () => {
	async function listWith(
		checkpointRows: unknown[],
		writeRows: unknown[] = [],
	) {
		const { client, saver } = make();
		client.rows = [checkpointRows, writeRows];
		const out = [];
		for await (const tuple of saver.list({ configurable: {} })) {
			out.push(tuple);
		}
		return out;
	}

	async function row(
		saver: SurrealDBSaver,
		overrides: Partial<Record<string, unknown>> = {},
	) {
		const cp: Checkpoint = { ...emptyCheckpoint(), id: 'c1' };
		const [type, bytes] = await saver.serde.dumpsTyped(cp);
		return {
			thread_id: 't1',
			checkpoint_ns: '',
			checkpoint_id: 'c1',
			parent_id: null,
			type,
			checkpoint: bytes,
			metadata: { source: 'loop', step: 1, parents: {} },
			...overrides,
		};
	}

	it('populates pendingWrites', async () => {
		const { saver } = make();
		const [wtype, wbytes] = await saver.serde.dumpsTyped('written');
		const tuples = await listWith(
			[await row(saver)],
			[
				{
					thread_id: 't1',
					checkpoint_ns: '',
					checkpoint_id: 'c1',
					task_id: 'task1',
					idx: 0,
					channel: 'messages',
					type: wtype,
					value: wbytes,
				},
			],
		);
		expect(tuples[0]?.pendingWrites).toEqual([
			['task1', 'messages', 'written'],
		]);
	});

	it('builds config from each row, not from the request', async () => {
		const { saver } = make();
		const tuples = await listWith([
			await row(saver, { thread_id: 'tA', checkpoint_ns: 'nsA' }),
		]);
		expect(tuples[0]?.config.configurable).toMatchObject({
			thread_id: 'tA',
			checkpoint_ns: 'nsA',
		});
	});

	it('carries the namespace into parentConfig too', async () => {
		const { saver } = make();
		const tuples = await listWith([
			await row(saver, {
				thread_id: 'tA',
				checkpoint_ns: 'nsA',
				parent_id: 'c0',
			}),
		]);
		expect(tuples[0]?.parentConfig?.configurable).toMatchObject({
			thread_id: 'tA',
			checkpoint_ns: 'nsA',
			checkpoint_id: 'c0',
		});
	});

	it('refuses an unreadable old checkpoint rather than skipping it', async () => {
		const { saver } = make();
		const old = { ...emptyCheckpoint(), id: 'c1', v: 1 };
		const [type, bytes] = await saver.serde.dumpsTyped(old);
		await expect(
			listWith([await row(saver, { type, checkpoint: bytes })]),
		).rejects.toThrow(/refusing to load Checkpoint v1/);
	});
});

describe('SurrealDBSaver.putWrites conflict policy', () => {
	async function writeAndCapture(channels: string[]) {
		const { client, saver } = make();
		client.rows = [[]];
		await saver.putWrites(
			{
				configurable: {
					thread_id: 't1',
					checkpoint_ns: '',
					checkpoint_id: 'c1',
				},
			},
			channels.map((c) => [c, 'v'] as [string, unknown]),
			'task1',
		);
		return client.queries.map((q) => q.surql);
	}

	it('overwrites the special channels, whose latest value is the real one', async () => {
		// An interrupt resumed twice must not keep the stale payload.
		for (const channel of Object.keys(WRITES_IDX_MAP)) {
			const queries = await writeAndCapture([channel]);
			expect(
				queries.some((q) => q.startsWith('UPSERT')),
				`${channel} should UPSERT`,
			).toBe(true);
		}
	});

	it('leaves an existing regular write alone', async () => {
		// A replayed task must not clobber what the first attempt recorded.
		const queries = await writeAndCapture(['messages']);
		expect(queries.some((q) => q.startsWith('SELECT id FROM'))).toBe(true);
		expect(queries.some((q) => q.startsWith('UPSERT'))).toBe(false);
	});
});
