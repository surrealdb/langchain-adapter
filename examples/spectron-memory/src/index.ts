// Required env: SPECTRON_API_KEY, SPECTRON_CONTEXT, SPECTRON_ENDPOINT.
import { SpectronClient } from '@surrealdb/langchain-core';
import { SpectronRetriever } from '@surrealdb/langchain/retrievers';
import { SpectronStore } from '@surrealdb/langgraph/spectron_store';

const apiKey = process.env.SPECTRON_API_KEY;
const context = process.env.SPECTRON_CONTEXT;
const endpoint = process.env.SPECTRON_ENDPOINT;
if (!apiKey || !context || !endpoint) {
	console.error(
		'Set SPECTRON_API_KEY, SPECTRON_CONTEXT and SPECTRON_ENDPOINT to run this example.',
	);
	process.exit(1);
}

const spectronClient = new SpectronClient({ context, apiKey, endpoint });

const spectronState = await spectronClient.state();
console.log('spectron state keys:', Object.keys(spectronState ?? {}));

const spectronHits = await spectronClient.knowledge.query(
	'what does the team know about onboarding?',
	{ mode: 'hybrid', k: 3 },
);
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
