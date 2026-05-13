# SurrealDB for LangChain and LangGraph

Official SurrealDB integration for the [LangChain.js](https://js.langchain.com/) and
[LangGraph.js](https://langchain-ai.github.io/langgraphjs/) ecosystems.

## Packages

| Package | Description |
| --- | --- |
| [`@surrealdb/langchain-core`](./packages/core) | Shared SurrealDB client, config, schema, filter helpers and Spectron HTTP client |
| [`@surrealdb/langchain`](./packages/langchain) | `VectorStore`, hybrid `Retriever`, `SpectronRetriever`, agent `Tool`s (incl. Spectron), persisting `ChatModel` wrapper |
| [`@surrealdb/langgraph`](./packages/langgraph) | LangGraph `BaseCheckpointSaver`, `BaseStore`, and Spectron-backed `SpectronStore` |

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

## Spectron

[Spectron](https://surrealdb.com) is SurrealDB's hosted agentic-memory
service. A typed HTTP client and LangChain / LangGraph adapters ship with
this monorepo. Spectron is independent of your SurrealDB instance — you can
host SurrealDB yourself while using SurrealDB's managed Spectron, or point
the client at staging, dev or a self-hosted deployment.

### Install and configure

```ts
import { Spectron } from '@surrealdb/langchain-core';

const spectronClient = new Spectron({
	context: 'acme-prod',
	apiKey: process.env.SPECTRON_API_KEY!,
	endpoint: 'https://api.spectron.dev',
});
```

| Field         | Default          | Notes                                                                                                          |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `context`     | required         | Context id, e.g. `"acme-prod"`. Pins every request to `/api/v1/{context}/…`.                                   |
| `apiKey`      | required         | Bearer token, sent as `Authorization: Bearer …`.                                                               |
| `endpoint`    | **required**     | Spectron URL. Use `https://api.spectron.dev` for prod, or any staging / dev / self-host URL. **No default** — configured separately from your SurrealDB URL. |
| `timeout`     | `30000` ms       | Per-request timeout (`AbortController`).                                                                       |
| `maxRetries`  | `3`              | GET-only retries on network errors and 5xx. Backoff schedule: `[250 ms, 500 ms, 1 s]`. Writes never retry.     |
| `fetch`       | `globalThis.fetch` | Inject a custom `fetch` (mainly for tests).                                                                  |

`endpoint` and `apiKey` are also mutable after construction — changes apply
to the next request:

```ts
spectronClient.endpoint = 'https://staging.spectron.example';
spectronClient.apiKey = 'sk-rotated-…';
```

The full surface is also exported at the `@surrealdb/langchain-core/spectron`
subpath, where every model type is unprefixed (the top-level package re-exports
client / error / enum names with a `Spectron*` prefix to avoid clashes).

### Knowledge

#### Documents

```ts
const spectronDoc = await spectronClient.knowledge.upload({
	file: pdfBytes,           // Blob | ArrayBuffer | Uint8Array | ArrayBufferView
	title: 'Returns Policy',
	profile: 'multimodal_balanced',
	scope: { org: 'anneal' },
});

await spectronClient.knowledge.get(spectronDoc.id);
await spectronClient.knowledge.replace(spectronDoc.id, { file: newPdfBytes });
await spectronClient.knowledge.raw(spectronDoc.id);              // → Uint8Array
await spectronClient.knowledge.chunks(spectronDoc.id, { page: 0, pageSize: 50 });
await spectronClient.knowledge.list({ status: 'ready', mimeType: 'application/pdf' });
await spectronClient.knowledge.related(spectronDoc.id);
await spectronClient.knowledge.delete(spectronDoc.id);
```

`profile` is one of `text_only`, `text_plus_ocr`, `multimodal_balanced`,
`multimodal_full`. Pass file bytes directly — string paths are intentionally
not supported in the JS client (read with `node:fs/promises.readFile` first).

#### Query

```ts
import type { SpectronQueryMode } from '@surrealdb/langchain-core';

const spectronHits = await spectronClient.knowledge.query({
	query: 'return window for unopened items?',
	mode: 'hybrid_graph' satisfies SpectronQueryMode, // 'vector' | 'bm25' | 'hybrid' | 'hybrid_graph'
	k: 10,
	threshold: 0.5,
	vectorWeight: 0.5,
	rrfK: 60,
	graphAlpha: 0.3,
	graphEdges: ['knowledge_has_keyword', 'knowledge_relates_to'],
	graphDepth: 2,
	expandGraph: true,
	filter: { mimeType: ['application/pdf'], scope: { org: 'anneal' } },
});
```

#### Keywords

```ts
await spectronClient.knowledge.keywords.list({ minDocumentCount: 2, sort: '-document_count', q: 'return' });
await spectronClient.knowledge.keywords.get('RETURN POLICY');
await spectronClient.knowledge.keywords.search({ query: 'refund policies', k: 10, threshold: 0.6 });
await spectronClient.knowledge.keywords.related('RETURN POLICY');
await spectronClient.knowledge.keywords.forDocument(spectronDoc.id);
```

#### Nodes

```ts
await spectronClient.knowledge.nodes.upsert({
	nodes: [
		{ kind: 'product', slug: 'airpods_pro_2', title: 'AirPods Pro 2',
			content: { price: 249, category: 'Audio' } },
		{ kind: 'policy', slug: 'returns', title: 'Returns',
			content: { duration: '30 days' } },
	],
	relations: [
		{ label: 'covered_by', to: { kind: 'policy', slug: 'returns' } },
	],
	scope: { org: 'apple' },
});

await spectronClient.knowledge.nodes.list({ kind: 'product' });
await spectronClient.knowledge.nodes.search({ query: 'audio products', k: 10 });
await spectronClient.knowledge.nodes.get('product', 'airpods_pro_2');
await spectronClient.knowledge.nodes.related('product', 'airpods_pro_2');
await spectronClient.knowledge.nodes.delete('product', 'airpods_pro_2');
```

#### Traversal

```ts
await spectronClient.knowledge.traverse({
	start: [{ type: 'document', id: spectronDoc.id }],
	edges: ['knowledge_has_keyword', 'knowledge_relates_to'],
	maxDepth: 2,
});

await spectronClient.knowledge.traverseRecursive({
	start: { type: 'knowledge', kind: 'product', slug: 'airpods_pro_2' },
	edge: 'knowledge_relates_to',
	maxDepth: 3,
});

await spectronClient.knowledge.traverseSiblings({
	start: { type: 'knowledge', kind: 'product', slug: 'airpods_pro_2' },
	edge: 'knowledge_relates_to',
});
```

### Sessions

Let Spectron run the loop:

```ts
const spectronSession = await spectronClient.sessions.create({ scope: { user: 'tobie' } });
const spectronReply = await spectronSession.chat({ message: 'What do you know about me?' });
await spectronSession.close();
```

Or drive it yourself:

```ts
const spectronSession = await spectronClient.sessions.create({ scope: { user: 'tobie' } });

await spectronSession.turn({ role: 'user', content: 'I just got promoted to CTO' });

const spectronContext = await spectronSession.context({ query: 'What is Tobie’s role?' });
const llmReply = await myLLM.chat({ system: spectronContext.context, user: userMessage });
await spectronSession.turn({ role: 'assistant', content: llmReply });

await spectronSession.turns();
await spectronSession.close();
```

### One-shot retrieval

```ts
await spectronClient.query({ query: 'What role does Christian have?', k: 10 });
await spectronClient.context({ query: 'brief on tobie', k: 10 });
```

### State, profile, entities

```ts
await spectronClient.state();
await spectronClient.profile();

await spectronClient.entities.list({ type: 'Person' });
await spectronClient.entities.get('Person', 'christian_battaglia');
await spectronClient.entities.history('Person', 'christian_battaglia', 'role');
await spectronClient.entities.delete('Person', 'christian_battaglia'); // soft delete
```

### Reflect, forget, lifecycle, traces

```ts
await spectronClient.reflect({ query: 'patterns in customer complaints this month?', persist: true });
await spectronClient.forget({ query: 'anything about my old job' });

await spectronClient.lifecycle.expire();
await spectronClient.lifecycle.decay();

await spectronClient.traces.list({ limit: 50 });
await spectronClient.traces.get('decision_trace:abc123');
await spectronClient.traces.stats();
```

### Scope

Scope is a plain object. The client serialises it to Spectron's wire format
and the server enforces matching and floors:

```ts
await spectronClient.sessions.create({ scope: { org: 'anneal' } });
await spectronClient.sessions.create({
	scope: { org: 'anneal', user: 'tobie', project: 'spectron' },
});
```

If you need the raw conversion, `serialiseScope` / `deserialiseScope` are
exported from `@surrealdb/langchain-core/spectron`.

### Errors

```ts
import {
	SpectronNotFoundError,
	SpectronRateLimitError,
} from '@surrealdb/langchain-core';

try {
	await spectronClient.knowledge.get('doc:missing');
} catch (err) {
	if (err instanceof SpectronNotFoundError) {
		console.log(err.status, err.detail);
	} else if (err instanceof SpectronRateLimitError) {
		console.log('retry after', err.retryAfter, 'seconds');
	} else {
		throw err;
	}
}
```

| Class                       | HTTP        |
| --------------------------- | ----------- |
| `SpectronError`             | base        |
| `SpectronAuthError`         | 401         |
| `SpectronScopeError`        | 403         |
| `SpectronNotFoundError`    | 404         |
| `SpectronValidationError`   | 400, 422    |
| `SpectronRateLimitError`    | 429 (with `retryAfter`) |
| `SpectronServerError`       | 5xx         |

Every error carries `status`, `title`, `detail`, `typeUri`, `instance`, and
`extensions` parsed from an RFC 7807 problem body when one is present.

### Retries and timeouts

- `GET` retries on connection errors and 5xx: 250 ms, 500 ms, 1 s — up to
  `maxRetries` (default `3`).
- Writes never retry. Handle failure yourself.
- Default timeout is 30 s. Override with `timeout` on the constructor, or per
  call by passing your own `AbortSignal` through the underlying transport.

### LangChain integrations

`SpectronRetriever` translates `knowledge.query` hits into LangChain
`Document`s, with chunk text as `pageContent` and document / chunk / score /
graph metadata in `metadata`:

```ts
import { SpectronRetriever } from '@surrealdb/langchain/retrievers';

const spectronRetriever = new SpectronRetriever({
	client: spectronClient,
	mode: 'hybrid_graph',
	k: 8,
	filter: { mimeType: ['application/pdf'] },
});
const spectronDocs = await spectronRetriever.invoke('what is the return policy?');
```

Two `StructuredTool`s wire Spectron into agents:

```ts
import { SpectronQueryTool, SpectronReflectTool } from '@surrealdb/langchain/tools';

const spectronTools = [
	new SpectronQueryTool({ client: spectronClient }),
	new SpectronReflectTool({ client: spectronClient }),
];
```

`SpectronQueryTool` accepts `{ query, k?, mode?, filter? }` and returns a
compact JSON array of hits; `SpectronReflectTool` accepts `{ query, persist? }`
and returns the reflection. Both also accept a `SpectronConfig` object
instead of an instantiated client.

### LangGraph store

`SpectronStore` is a `BaseStore` adapter — read paths delegate to Spectron,
writes are not supported (Spectron writes flow through sessions / reflections,
not raw key/value):

```ts
import { SpectronStore } from '@surrealdb/langgraph/spectron_store';

const spectronStore = new SpectronStore({ spectron: spectronClient });
await spectronStore.get(['Person'], 'tobie');                                  // → entities.get
await spectronStore.search(['Person'], { query: 'who is tobie?', limit: 5 });  // → Spectron.query
```

| Method            | Backed by              | Supported              |
| ----------------- | ---------------------- | ---------------------- |
| `get`             | `entities.get`         | yes                    |
| `search`          | `Spectron.query`       | yes (requires `query`) |
| `put`             | —                      | throws                 |
| `delete`          | —                      | throws                 |
| `listNamespaces`  | —                      | throws                 |

The LangGraph `namespace: string[]` is flattened into Spectron's entity
`type` with `"/"` by default; override with the `namespaceSeparator` arg.

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
