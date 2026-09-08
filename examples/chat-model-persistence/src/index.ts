import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { SurrealDBChatModel } from '@surrealdb/langchain';

const persisting = new SurrealDBChatModel({
	surreal: {
		url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
		username: process.env.SURREALDB_USER ?? 'root',
		password: process.env.SURREALDB_PASS ?? 'root',
		namespace: 'examples',
		database: 'chat',
	},
	delegate: new ChatOpenAI({ model: 'gpt-4.1-mini' }),
	threadId: 'demo-conversation',
});

const reply = await persisting.invoke([
	new HumanMessage('Summarise SurrealDB in one sentence.'),
]);
console.log(reply.text);

await persisting.close();
