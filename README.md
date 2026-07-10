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

## SurrealDB

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

[Spectron](https://surrealdb.com/platform/spectron) is SurrealDB's hosted agentic-memory service.
The LangChain / LangGraph adapters wrap the official
[`@surrealdb/spectron`](https://www.npmjs.com/package/@surrealdb/spectron)
client, which `@surrealdb/langchain-core` re-exports. `endpoint`, `apiKey`, and
`context` are all required — there is no implicit default host.

### Install and configure

```ts
import { Spectron } from '@surrealdb/langchain-core';

const spectronClient = new Spectron({
	context: 'acme-prod',
	apiKey: process.env.SPECTRON_API_KEY!,
	endpoint: process.env.SPECTRON_ENDPOINT!,
});
```

Or let the adapters resolve a client from the environment with the
`resolveSpectron` helper — it reads `SPECTRON_ENDPOINT`, `SPECTRON_API_KEY`,
and `SPECTRON_CONTEXT`, throwing a clear error if any is missing, and passes a
pre-constructed `Spectron` through untouched:

```ts
import { resolveSpectron } from '@surrealdb/langchain-core';

const spectronClient = resolveSpectron({}); // all three from env
```

| Field         | Default            | Notes                                                                                                      |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `context`     | required           | Context id, e.g. `"acme-prod"`. Pins every request to `/api/v1/{context}/…`.                               |
| `apiKey`      | required           | Bearer token, sent as `Authorization: Bearer …`.                                                           |
| `endpoint`    | required           | Spectron API origin (no trailing slash), e.g. `https://spectron.surrealdb.com`.                            |
| `timeout`     | `30000` ms         | Per-request timeout (`AbortController`).                                                                    |
| `maxRetries`  | `3`                | GET-only retries on network errors and 5xx. Writes never retry.                                            |
| `fetchImpl`   | `globalThis.fetch` | Inject a custom `fetch` (mainly for tests).                                                                 |

The full client surface is also re-exported at the
`@surrealdb/langchain-core/spectron` subpath (a pass-through of
`@surrealdb/spectron`, with model types unprefixed). The top-level package
re-exports the client, error and enum names with a `Spectron*` prefix to avoid
clashes.

### Documents

```ts
const spectronDoc = await spectronClient.documents.upload({
	file: pdfBytes,           // File | Blob | Uint8Array | ArrayBuffer | ArrayBufferView | ReadableStream
	contentType: 'application/pdf',
	filename: 'returns.pdf',
	title: 'Returns Policy',
	source: 'handbook',
	scopes: [['org:anneal']], // DNF scope selector (outer OR, inner AND)
	labels: ['team=support'],
});

await spectronClient.documents.get(spectronDoc.id);
await spectronClient.documents.reprocess(spectronDoc.id, { file: newPdfBytes });
await spectronClient.documents.raw(spectronDoc.id);              // → ArrayBuffer
await spectronClient.documents.chunks(spectronDoc.id, { page: 0, pageSize: 50 });
await spectronClient.documents.list({ status: 'ready', mimeType: 'application/pdf' });
await spectronClient.documents.delete(spectronDoc.id);
await spectronClient.documents.recomputeLinks();
```

Pass file bytes directly; string paths are intentionally not supported in the
JS client (read with `node:fs/promises.readFile` first).

#### Query

```ts
import type { SpectronQueryMode } from '@surrealdb/langchain-core';

const spectronHits = await spectronClient.documents.query({
	query: 'return window for unopened items?',
	mode: 'hybrid_graph' satisfies SpectronQueryMode, // 'vector' | 'bm25' | 'hybrid' | 'hybrid_graph'
	k: 10,
	threshold: 0.5,
	rrfK: 60,
	graphAlpha: 0.3,
	graphEdges: ['knowledge_has_keyword', 'knowledge_relates_to'],
	graphDepth: 2,
	expandGraph: true,
	filter: { mimeType: ['application/pdf'] },
});
```

#### Keywords

```ts
await spectronClient.documents.keywords.list({ minDocumentCount: 2, sort: '-document_count', q: 'return' });
await spectronClient.documents.keywords.get('RETURN POLICY');
await spectronClient.documents.keywords.search({ query: 'refund policies', k: 10, threshold: 0.6 });
await spectronClient.documents.keywords.forDocument(spectronDoc.id);
```

### Sessions

Let Spectron run the loop with the top-level `chat` endpoint:

```ts
const spectronReply = await spectronClient.chat('What do you know about me?', {
	scopes: [['user:tobie']],
});
```

Or open a session and drive the turns yourself:

```ts
const spectronSession = await spectronClient.sessions.create({
	scopes: [['user:tobie']],
});

const spectronContext = await spectronSession.context({ query: "What is Tobie's role?" });
const llmReply = await myLLM.chat({ system: spectronContext.context, user: userMessage });

await spectronSession.turns();
await spectronSession.close();
```

### One-shot retrieval

```ts
await spectronClient.recall('What role does Christian have?', { k: 10 });
await spectronClient.context('brief on tobie', { k: 10 });
```

### State, profile, entities

```ts
await spectronClient.state();
await spectronClient.profile();
await spectronClient.whoami();

await spectronClient.entities.list({ type: 'Person' });
await spectronClient.entities.get('Person', 'christian_battaglia'); // → { entity, attributes, relations }
await spectronClient.entities.history('Person', 'christian_battaglia', 'role');
await spectronClient.entities.delete('Person', 'christian_battaglia'); // soft delete
```

### Remember, reflect, forget, lifecycle, traces

```ts
await spectronClient.remember('Christian was promoted to CTO', { scopes: [['user:christian']] });
await spectronClient.reflect('patterns in customer complaints this month?', { persist: true });
await spectronClient.forget('anything about my old job', { purge: false });

await spectronClient.lifecycle.expire();
await spectronClient.lifecycle.decay();

await spectronClient.traces.list({ limit: 50 });
await spectronClient.traces.get('decision_trace:abc123');
await spectronClient.traces.stats();
```

Higher-level operators (`consolidate`, `elaborate`, `fsck`, `inspect`, `audit`)
and scope administration (`scopes`, `principals`, `keys`) are available on the
client as well — see the [`@surrealdb/spectron`](https://www.npmjs.com/package/@surrealdb/spectron)
docs.

### Scope

Scope is a DNF selector — an outer OR of inner AND groups, expressed as an
array of string arrays (a plain string or string array is also accepted):

```ts
await spectronClient.sessions.create({ scopes: [['org:anneal']] });
await spectronClient.sessions.create({
	scopes: [['org:anneal', 'user:tobie', 'project:spectron']],
});
```

`normaliseScope` (from `@surrealdb/langchain-core/spectron`) converts loose
scope input into the canonical `string[][]` form.

### Errors

```ts
import {
	SpectronNotFoundError,
	SpectronRateLimitError,
} from '@surrealdb/langchain-core';

try {
	await spectronClient.documents.get('doc:missing');
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
| `SpectronConnectionError`   | network / timeout (status `0`) |

Every error carries `status`, `title`, `detail`, `type`, `instance`, and
`extensions` parsed from an RFC 7807 problem body when one is present.

### Retries and timeouts

- `GET` retries on connection errors and 5xx: 250 ms, 500 ms, 1 s, up to
  `maxRetries` (default `3`).
- Writes never retry. Handle failure yourself.
- Default timeout is 30 s. Override with `timeout` on the constructor, or per
  call by passing your own `AbortSignal` through the underlying transport.

### LangChain integrations

`SpectronRetriever` translates `documents.query` hits into LangChain
`Document`s, with chunk text as `pageContent` and document, chunk, score and
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
and returns the reflection. Both also accept a plain config object (resolved
via `resolveSpectron`, incl. `SPECTRON_*` env vars) instead of an instantiated
client.

### LangGraph store

`SpectronStore` is a `BaseStore` adapter. Read paths delegate to Spectron;
writes are not supported (Spectron writes flow through sessions and
reflections, not raw key/value):

```ts
import { SpectronStore } from '@surrealdb/langgraph/spectron_store';

const spectronStore = new SpectronStore({ spectron: spectronClient });
await spectronStore.get(['Person'], 'tobie');                                  // → entities.get
await spectronStore.search(['Person'], { query: 'who is tobie?', limit: 5 });  // → Spectron.recall
```

| Method            | Backed by              | Supported              |
| ----------------- | ---------------------- | ---------------------- |
| `get`             | `entities.get`         | yes                    |
| `search`          | `Spectron.recall`      | yes (requires `query`) |
| `put`             | n/a                    | throws                 |
| `delete`          | n/a                    | throws                 |
| `listNamespaces`  | n/a                    | throws                 |

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
