# SurrealDB for LangChain and LangGraph

Official SurrealDB integration for the [LangChain.js](https://js.langchain.com/) and
[LangGraph.js](https://langchain-ai.github.io/langgraphjs/) ecosystems.

## Packages

| Package | Description |
| --- | --- |
| [`@surrealdb/langchain-core`](./packages/core) | Shared SurrealDB client, config, schema and filter helpers |
| [`@surrealdb/langchain`](./packages/langchain) | `VectorStore`, hybrid `Retriever`, agent `Tool`s, persisting `ChatModel` wrapper |
| [`@surrealdb/langgraph`](./packages/langgraph) | LangGraph `BaseCheckpointSaver` and `BaseStore` |

## Requirements

- **SurrealDB server**: v3.x (uses HNSW vector indexes, `bytes` type, `<|k,dist|>` kNN operator)
- **SurrealDB JS SDK**: v2.x
- **Runtime**: Node.js ≥ 22 or Bun ≥ 1

## Quick start

```bash
bun add @surrealdb/langchain @surrealdb/langgraph surrealdb
```

```ts
import { OpenAIEmbeddings } from '@langchain/openai';
import { VectorStore } from '@surrealdb/langchain';

const store = await VectorStore.initialize(new OpenAIEmbeddings(), {
	surreal: {
		url: 'ws://localhost:8000',
		username: 'root',
		password: 'root',
		namespace: 'app',
		database: 'rag',
	},
	tableName: 'documents',
	dimensions: 1536,
});

await store.addDocuments([{ pageContent: 'hello world', metadata: {} }]);
const hits = await store.similaritySearch('hi', 4);
```

## Local development

```bash
bun install
docker compose up -d            # SurrealDB v3 on :8000
bun run typecheck
bun run test
bun run test:integration
```

## License

Apache-2.0
