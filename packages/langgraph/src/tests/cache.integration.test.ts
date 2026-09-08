import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { afterAll, describe, expect, it } from 'vitest';
import { SurrealDBNodeCache } from '../cache.js';
import { makeConfig } from './helpers.js';

describe('SurrealDBNodeCache', () => {
	const cache = new SurrealDBNodeCache({ surreal: makeConfig('nodecache') });
	afterAll(() => cache.close());

	it('round-trips values through the serde', async () => {
		const key: [string[], string] = [['ns'], 'k1'];
		expect(await cache.get([key])).toEqual([]);
		await cache.set([{ key, value: { n: 1, s: 'x' } }]);
		const got = await cache.get([key]);
		expect(got).toHaveLength(1);
		expect(got[0]?.value).toEqual({ n: 1, s: 'x' });
	});

	it('omits keys it does not hold', async () => {
		const hit: [string[], string] = [['ns'], 'k1'];
		const miss: [string[], string] = [['ns'], 'nope'];
		const got = await cache.get([hit, miss]);
		expect(got).toHaveLength(1);
		expect(got[0]?.key).toBe(hit);
	});

	it('stops serving an entry once its ttl has elapsed', async () => {
		const key: [string[], string] = [['ns'], 'ttl'];
		await cache.set([{ key, value: 1, ttl: -1 }]);
		expect(await cache.get([key])).toEqual([]);
	});

	it('clears a single namespace', async () => {
		const a: [string[], string] = [['nsA'], 'k'];
		const b: [string[], string] = [['nsB'], 'k'];
		await cache.set([
			{ key: a, value: 1 },
			{ key: b, value: 2 },
		]);
		await cache.clear([['nsA']]);
		expect(await cache.get([a])).toEqual([]);
		expect(await cache.get([b])).toHaveLength(1);
	});

	it('clears everything when given an empty namespace list', async () => {
		const b: [string[], string] = [['nsB'], 'k'];
		await cache.clear([]);
		expect(await cache.get([b])).toEqual([]);
	});
});

describe('SurrealDBNodeCache in a real graph', () => {
	it('skips a cached node on the second run', async () => {
		const cache = new SurrealDBNodeCache({
			surreal: makeConfig('graphcache'),
		});
		let calls = 0;

		const State = Annotation.Root({
			value: Annotation<number>({
				reducer: (_a, b) => b,
				default: () => 0,
			}),
		});

		const graph = new StateGraph(State)
			.addNode(
				'expensive',
				async (state) => {
					calls++;
					return { value: state.value + 1 };
				},
				{ cachePolicy: { ttl: 60 } },
			)
			.addEdge(START, 'expensive')
			.addEdge('expensive', END)
			.compile({ cache });

		await graph.invoke({ value: 1 });
		expect(calls).toBe(1);

		// Same input, so the cached write is replayed rather than recomputed.
		await graph.invoke({ value: 1 });
		expect(calls).toBe(1);

		// Different input is a different cache key.
		await graph.invoke({ value: 2 });
		expect(calls).toBe(2);

		await cache.close();
	});
});
