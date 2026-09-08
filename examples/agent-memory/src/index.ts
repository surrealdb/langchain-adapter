// Required env: AGENT_MEMORY_ENDPOINT, AGENT_MEMORY_API_KEY, AGENT_MEMORY_CONTEXT.

import { AgentMemoryRetriever } from '@surrealdb/langchain/retrievers';
import { resolveAgentMemory } from '@surrealdb/langchain-core';
import { AgentMemoryStore } from '@surrealdb/langgraph/memory_store';

let agentMemoryClient: ReturnType<typeof resolveAgentMemory>;
try {
	// Reads AGENT_MEMORY_ENDPOINT / AGENT_MEMORY_API_KEY / AGENT_MEMORY_CONTEXT from the env.
	agentMemoryClient = resolveAgentMemory({});
} catch (err) {
	console.error((err as Error).message);
	process.exit(1);
}

// `state()` takes a bound in alpha.9; `truncated` reports which tables hit it.
const agentMemoryState = await agentMemoryClient.state({ limit: 100 });
console.log('memory state keys:', Object.keys(agentMemoryState ?? {}));

const agentMemoryHits = await agentMemoryClient.documents.query({
	query: 'what does the team know about onboarding?',
	mode: 'hybrid',
	k: 3,
});
for (const hit of agentMemoryHits.results) {
	console.log(
		`[${hit.score.toFixed(3)}] ${hit.document.title}: ${hit.chunk.text.slice(0, 80)}…`,
	);
}

const agentMemoryRetriever = new AgentMemoryRetriever({
	client: agentMemoryClient,
	mode: 'hybrid_graph',
	k: 4,
});
const agentMemoryDocs = await agentMemoryRetriever.invoke(
	'what should a new hire read first?',
);
console.log('retriever returned', agentMemoryDocs.length, 'documents');

// Agent Memory recall has no namespace dimension. `namespaceMode: 'lens'`
// maps a namespace onto a scope lens, which is a real server-side narrowing;
// the default ('error') refuses a namespace rather than returning unscoped
// hits labelled as if they were scoped.
const agentMemoryStore = new AgentMemoryStore({
	client: agentMemoryClient,
	namespaceMode: 'lens',
});
const agentMemorySearchItems = await agentMemoryStore.search(['team', 'eng'], {
	query: 'who is the CTO?',
	limit: 3,
});
console.log(
	'store search returned',
	agentMemorySearchItems.length,
	'items; top score =',
	agentMemorySearchItems[0]?.score,
);
