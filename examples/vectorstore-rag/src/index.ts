import { Document } from '@langchain/core/documents';
import { OpenAIEmbeddings } from '@langchain/openai';
import { VectorStore } from '@surrealdb/langchain';

const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });

const store = await VectorStore.initialize(embeddings, {
	surreal: {
		url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
		username: process.env.SURREALDB_USER ?? 'root',
		password: process.env.SURREALDB_PASS ?? 'root',
		namespace: 'examples',
		database: 'rag',
	},
	tableName: 'documents',
	dimensions: 1536,
});

await store.addDocuments([
	new Document({
		pageContent:
			'SurrealDB is a multi-model database supporting documents, graphs and vectors.',
		metadata: { source: 'docs', topic: 'overview' },
	}),
	new Document({
		pageContent:
			'LangChain is a framework for building LLM-powered applications.',
		metadata: { source: 'docs', topic: 'langchain' },
	}),
	new Document({
		pageContent:
			'LangGraph adds stateful, multi-actor agent orchestration on top of LangChain.',
		metadata: { source: 'docs', topic: 'langgraph' },
	}),
]);

const hits = await store.similaritySearchWithScore(
	'How do I store agent state?',
	2,
);
for (const [doc, score] of hits) {
	console.log(
		`[${score.toFixed(4)}] (${doc.metadata?.topic}) ${doc.pageContent}`,
	);
}

await store.close();
