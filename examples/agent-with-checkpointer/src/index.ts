// A LangChain v1 agent with SurrealDB behind both persistence layers:
// short-term state (checkpointer) and long-term memory (store).
//
// For node-result caching, see ../node-cache.
//
// Requires OPENAI_API_KEY, plus a SurrealDB v3 instance (docker compose up -d).

import { ChatOpenAI } from '@langchain/openai';
import { SurrealDBSaver, SurrealDBStore } from '@surrealdb/langgraph';
import { createAgent } from 'langchain';

const surreal = {
	url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
	username: process.env.SURREALDB_USER ?? 'root',
	password: process.env.SURREALDB_PASS ?? 'root',
	namespace: 'examples',
	database: 'agent',
};

const checkpointer = new SurrealDBSaver({ surreal });
const store = new SurrealDBStore({ surreal });
await store.start();

// `createAgent` takes a BaseCheckpointSaver and a BaseStore directly, so the
// adapters drop straight in.
const agent = createAgent({
	model: new ChatOpenAI({ model: 'gpt-4.1-mini' }),
	tools: [],
	checkpointer,
	store,
});

const config = { configurable: { thread_id: 'demo-thread' } };

await agent.invoke(
	{ messages: [{ role: 'user', content: 'What is SurrealDB?' }] },
	config,
);

// The checkpointer makes the second turn aware of the first.
const final = await agent.invoke(
	{
		messages: [
			{ role: 'user', content: 'And how does it differ from Postgres?' },
		],
	},
	config,
);

for (const m of final.messages) console.log(`${m.getType()}: ${m.text}`);

// Read the persisted checkpoints back, newest first — `pendingWrites` are
// populated, so pending tasks show up here too.
for await (const tuple of checkpointer.list(config, { limit: 5 })) {
	console.log(
		'checkpoint',
		tuple.config.configurable?.checkpoint_id,
		`(${tuple.pendingWrites?.length ?? 0} pending writes)`,
	);
}

await checkpointer.close();
await store.stop();
