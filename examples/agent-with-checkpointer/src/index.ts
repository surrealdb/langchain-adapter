import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { CheckpointSaver } from '@surrealdb/langgraph';

const State = Annotation.Root({
	messages: Annotation<string[]>({
		reducer: (a, b) => [...a, ...b],
		default: () => [],
	}),
});

const llm = new ChatOpenAI({ model: 'gpt-4.1-mini' });

const graph = new StateGraph(State)
	.addNode('respond', async (state) => {
		const lastQ = state.messages.at(-1) ?? '';
		const reply = await llm.invoke([new HumanMessage(lastQ)]);
		return { messages: [`assistant: ${reply.text}`] };
	})
	.addEdge(START, 'respond')
	.addEdge('respond', END);

const checkpointer = new CheckpointSaver({
	surreal: {
		url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
		username: process.env.SURREALDB_USER ?? 'root',
		password: process.env.SURREALDB_PASS ?? 'root',
		namespace: 'examples',
		database: 'agent',
	},
});

const app = graph.compile({ checkpointer });
const config = { configurable: { thread_id: 'demo-thread' } };

await app.invoke(
	{ messages: ['user: What is SurrealDB?'] },
	config,
);
const final = await app.invoke(
	{ messages: ['user: And what makes it different from Postgres?'] },
	config,
);

for (const m of final.messages) console.log(m);

await checkpointer.close();
