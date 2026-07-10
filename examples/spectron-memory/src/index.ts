// Required env: SPECTRON_ENDPOINT, SPECTRON_API_KEY, SPECTRON_CONTEXT.

import { SpectronRetriever } from '@surrealdb/langchain/retrievers';
import { resolveSpectron } from '@surrealdb/langchain-core';
import { SpectronStore } from '@surrealdb/langgraph/spectron_store';

let spectronClient: ReturnType<typeof resolveSpectron>;
try {
	// Reads SPECTRON_ENDPOINT / SPECTRON_API_KEY / SPECTRON_CONTEXT from the env.
	spectronClient = resolveSpectron({});
} catch (err) {
	console.error((err as Error).message);
	process.exit(1);
}

const spectronState = await spectronClient.state();
console.log('spectron state keys:', Object.keys(spectronState ?? {}));

const spectronHits = await spectronClient.documents.query({
	query: 'what does the team know about onboarding?',
	mode: 'hybrid',
	k: 3,
});
for (const hit of spectronHits.results) {
	console.log(
		`[${hit.score.toFixed(3)}] ${hit.document.title}: ${hit.chunk.text.slice(0, 80)}…`,
	);
}

const spectronRetriever = new SpectronRetriever({
	client: spectronClient,
	mode: 'hybrid_graph',
	k: 4,
});
const spectronDocs = await spectronRetriever.invoke(
	'what should a new hire read first?',
);
console.log('retriever returned', spectronDocs.length, 'documents');

const spectronStore = new SpectronStore({ spectron: spectronClient });
const spectronSearchItems = await spectronStore.search(['Person'], {
	query: 'who is the CTO?',
	limit: 3,
});
console.log(
	'store search returned',
	spectronSearchItems.length,
	'items; top score =',
	spectronSearchItems[0]?.score,
);
