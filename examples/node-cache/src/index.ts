// Caching expensive graph nodes in SurrealDB.
//
// LangGraph v1 lets a node declare a `cachePolicy`; a `BaseCache` on the
// compiled graph decides where those results live. Requires a SurrealDB v3
// instance (docker compose up -d).

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SurrealDBNodeCache } from '@surrealdb/langgraph';

const cache = new SurrealDBNodeCache({
	surreal: {
		url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
		username: process.env.SURREALDB_USER ?? 'root',
		password: process.env.SURREALDB_PASS ?? 'root',
		namespace: 'examples',
		database: 'cache',
	},
});

const State = Annotation.Root({
	input: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
	output: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
});

let calls = 0;

const graph = new StateGraph(State)
	.addNode(
		'expensive',
		async (state) => {
			calls++;
			await new Promise((r) => setTimeout(r, 500)); // pretend it's slow
			return { output: state.input.toUpperCase() };
		},
		// Cache this node's result for two minutes, keyed on its input.
		{ cachePolicy: { ttl: 120 } },
	)
	.addEdge(START, 'expensive')
	.addEdge('expensive', END)
	.compile({ cache });

console.time('first run');
console.log(await graph.invoke({ input: 'hello' }));
console.timeEnd('first run');

console.time('second run (cached)');
console.log(await graph.invoke({ input: 'hello' }));
console.timeEnd('second run (cached)');

console.log(`node executed ${calls} time(s)`);

await cache.close();
