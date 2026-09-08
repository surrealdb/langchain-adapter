# SurrealDB for LangChain and LangGraph

Official SurrealDB integrations for [LangChain.js](https://js.langchain.com/) and
[LangGraph.js](https://langchain-ai.github.io/langgraphjs/), plus adapters for
[SurrealDB Agent Memory](https://surrealdb.com/agent-memory).

## Packages

| Package | Description |
| --- | --- |
| [`@surrealdb/langchain-core`](./packages/core) | Shared SurrealDB client, config, schema, filter and record helpers, plus the Agent Memory client |
| [`@surrealdb/langchain`](./packages/langchain) | Vector store, retrievers, tools, chat model, record manager, LLM cache, chat history, callback handler |
| [`@surrealdb/langgraph`](./packages/langgraph) | Checkpoint saver, store, node cache, and an Agent Memory-backed store |

## Requirements

- **SurrealDB server**: v3.x (HNSW/DISKANN vector indexes, `bytes` type, the `<|k,ef|>` kNN operator)
- **LangChain**: `@langchain/core` **v1** (`^1.2.9`) — v0.3 is not supported
- **LangGraph**: `@langchain/langgraph-checkpoint` `^1.1.5`
- **SurrealDB JS SDK**: v2.x · **zod**: `^3.25.76 || ^4`
- **Runtime**: Node.js ≥ 22 or Bun ≥ 1

```bash
bun add @surrealdb/langchain @surrealdb/langgraph surrealdb
```

Upgrading from 0.1.x? See [Migrating from 0.1.x](#migrating-from-01x) — 0.2.0 renames
every Agent Memory symbol and several bare exports.

---

## Vector store

```ts
import { OpenAIEmbeddings } from '@langchain/openai';
import { SurrealDBVectorStore } from '@surrealdb/langchain';

const store = await SurrealDBVectorStore.initialize(new OpenAIEmbeddings(), {
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

Searches use SurrealDB's kNN operator against the vector index. A metadata filter is
pushed *into* the index traversal rather than applied afterwards, so a filtered search
still returns a full `k`:

```ts
await store.similaritySearch('hi', 4, { topic: 'onboarding' });
```

**Scores are similarities — higher is better.** Cosine returns `1 - distance`; the
unbounded metrics are mapped to `1 / (1 + distance)`, which stays in `(0, 1]` and
preserves ordering. Pass `scoreMode: 'distance'` for the raw distance.

**Maximal marginal relevance** trades some relevance for diversity, and also powers
`asRetriever({ searchType: 'mmr' })`:

```ts
await store.maxMarginalRelevanceSearch('hi', { k: 4, fetchK: 20, lambda: 0.5 });
```

### The id contract

Ids go in and come back unchanged, and the ids you get are the ids `delete` accepts:

```ts
const ids = await store.addDocuments(docs, { ids: ['a', 'has space'] });
// → ['a', 'has space']
await store.delete({ ids });
```

Ids are stored as SurrealDB record ids, so no escaping is needed and none leaks into
what you get back. A table whose existing id parts are not strings (numbers, arrays,
objects) returns the fully-qualified `table:id` form; `delete({ ids })` rejects those
rather than guessing, so use `delete({ filter })` there.

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `tableName` | `documents` | |
| `contentField` / `metadataField` / `vectorField` | `content` / `metadata` / `embedding` | |
| `dimensions` | required | Must match your embedding model |
| `distanceStrategy` | `cosine` | `cosine`, `euclidean`, `manhattan`, `hamming` |
| `indexType` | `hnsw` | `hnsw`, `diskann` (SurrealDB ≥ 3.1), or `none` for brute force |
| `hnswOptions` / `diskannOptions` | `{ m: 12, efc: 100 }` | Index build parameters |
| `ef` | `40` | Search breadth |
| `scoreMode` | `similarity` | Or `distance` for the 0.1.x behaviour |
| `skipInitSchema` / `skipVersionCheck` | `false` | For externally-managed schemas |

## Retrievers

`HybridRetriever` seeds from a vector search and re-ranks by distance:

```ts
import { HybridRetriever } from '@surrealdb/langchain/retrievers';

const retriever = new HybridRetriever({
	surreal,
	embeddings,
	tableName: 'documents',
	seedK: 5,
	k: 10,
	filter: { topic: 'onboarding' },
});
```

> Graph expansion (`graphEdges`) is **not yet supported** and throws if set. The previous
> implementation could not work — under `SELECT VALUE` the `AS` alias is discarded, so the
> fan-out was always empty — and returning silently-empty results was worse than saying so.

## Tools

Tools are built with LangChain v1's `tool()` helper and return
`content_and_artifact`: the model sees a compact digest, your code gets the real rows
or `Document`s as `message.artifact`.

```ts
import {
	createQueryTool,
	createRecordTool,
	createTool,
} from '@surrealdb/langchain/tools';

// The agent writes the SurrealQL. Read-only by default.
const query = createQueryTool({ surreal, maxRows: 50 });

// The query is fixed; the agent only fills in typed parameters. Prefer this.
const findUser = createRecordTool({
	surreal,
	name: 'find_user',
	description: 'Find a user by name',
	schema: z.object({ name: z.string() }),
	surql: 'SELECT * FROM user WHERE name = $name',
});

// Your own handler, with the client pre-bound.
const custom = createTool({ surreal, name, description, schema, handler });
```

> `readOnly` rejects statements that are not a single `SELECT`/`INFO`/`RETURN`, contain a
> write, DDL or control keyword, or call `fn::`. Treat it as a guard-rail that catches
> mistakes early, **not** as a security boundary — a regex cannot be one. Anything reachable
> by an untrusted agent belongs behind a read-only SurrealDB user or record-level access.

## Chat model persistence

The recommended way to record LLM traffic is a callback handler: it leaves the model
untouched, so tool calling, structured output, streaming and caching all keep working.

```ts
import { SurrealDBChatCallbackHandler } from '@surrealdb/langchain/callbacks';

const model = new ChatOpenAI({ model: 'gpt-4.1-mini' }).withConfig({
	callbacks: [new SurrealDBChatCallbackHandler({ surreal, threadId: 'demo' })],
});
```

`SurrealDBChatModel` wraps a delegate model instead, for callers who need a
`BaseChatModel`-shaped object. It forwards `bindTools`, `withStructuredOutput` and the
metadata that tracing, token counting and caching read. Persistence failures are reported
through `onPersistError` rather than failing the call; set `strictPersistence: true` to
make them fatal.

## Record manager (the indexing API)

Keeps a vector store in sync with a source, skipping unchanged documents and deleting
removed ones.

```ts
import { index } from '@langchain/core/indexing';
import { SurrealDBRecordManager } from '@surrealdb/langchain/indexes';

const recordManager = await SurrealDBRecordManager.initialize({
	surreal,
	namespace: 'handbook',
});

await index({
	docsSource: docs,
	recordManager,
	vectorStore,
	options: { cleanup: 'incremental', sourceIdKey: 'source' },
});
```

Timestamps come from the server (in microseconds), so concurrent indexers agree on
ordering and two runs in the same millisecond do not collide.

## LLM cache

```ts
import { SurrealDBLLMCache } from '@surrealdb/langchain/caches';

const model = new ChatOpenAI({
	cache: new SurrealDBLLMCache({ surreal, ttlSeconds: 3600 }),
});
```

Prompts are **not** stored unless you pass `storePrompt: true` — they routinely contain
user data and the cache does not need them.

## Chat message history

```ts
import { SurrealDBChatMessageHistory } from '@surrealdb/langchain/chat_history';

const history = new SurrealDBChatMessageHistory({ surreal, sessionId: 'user-42' });
await history.addMessages([new HumanMessage('hi'), new AIMessage('hello')]);
```

Content blocks, tool calls, ids and response metadata all survive the round trip.
Appends run in a transaction, so concurrent writers to one session cannot collide on a
sequence number. Two limits: a `RemoveMessage` (or any type outside
`human | ai | system | function | tool | generic`) throws on read, and an
`AIMessageChunk` comes back as an `AIMessage`. With LangGraph, prefer `SurrealDBSaver` —
a checkpointer already persists the message list as graph state.

## LangGraph: checkpointer, store and cache

```ts
import { ChatOpenAI } from '@langchain/openai';
import {
	SurrealDBNodeCache,
	SurrealDBSaver,
	SurrealDBStore,
} from '@surrealdb/langgraph';
import { createAgent } from 'langchain';

const agent = createAgent({
	model: new ChatOpenAI({ model: 'gpt-4.1-mini' }),
	tools: [],
	checkpointer: new SurrealDBSaver({ surreal }),
	store: new SurrealDBStore({ surreal }),
});
```

**`SurrealDBSaver`** implements the full `BaseCheckpointSaver` contract. `list()` supports
cross-thread and cross-namespace listing (omit `thread_id` / `checkpoint_ns`), the
`before` / `limit` / `filter` options, and populates `pendingWrites` so
`getStateHistory()` reports pending tasks.

**`SurrealDBStore`** implements `BaseStore`, with optional semantic search:

```ts
const store = new SurrealDBStore({
	surreal,
	index: { dims: 1536, embeddings, fields: ['text'] },
});
await store.start();
await store.put(['users', 'alice'], 'pref', { text: 'prefers dark mode' });
await store.search(['users', 'alice'], { query: 'ui preferences', limit: 5 });
```

Filters support `$eq $ne $gt $gte $lt $lte $in $nin $exists`. A `query` with no `index`
configured warns once and returns unranked items; `strictSearch: true` makes it an error.

**`SurrealDBNodeCache`** backs LangGraph v1's per-node `cachePolicy`:

```ts
const graph = builder
	.addNode('expensive', fn, { cachePolicy: { ttl: 120 } })
	.compile({ cache: new SurrealDBNodeCache({ surreal }) });
```

---

## SurrealDB Agent Memory

[Agent Memory](https://surrealdb.com/agent-memory) is SurrealDB's hosted agentic-memory
service. These packages wrap the official
[`@surrealdb/memory`](https://www.npmjs.com/package/@surrealdb/memory) client, which
`@surrealdb/langchain-core` re-exports — see that package's README for the full client
surface (documents, sessions, entities, lifecycle, traces, scopes, keys, pagination).

### Configure

```ts
import { AgentMemory } from '@surrealdb/langchain-core';

const memory = new AgentMemory({
	context: 'acme-prod',
	apiKey: process.env.AGENT_MEMORY_API_KEY!,
	endpoint: process.env.AGENT_MEMORY_ENDPOINT!,
});
```

Or let the adapters build one from the environment. `resolveAgentMemory` reads
`AGENT_MEMORY_ENDPOINT`, `AGENT_MEMORY_API_KEY` and `AGENT_MEMORY_CONTEXT`, throws a
clear error naming whichever is missing, and passes a pre-constructed client through
untouched:

```ts
import { resolveAgentMemory } from '@surrealdb/langchain-core';

const memory = resolveAgentMemory({}); // all three from the environment
```

`endpoint`, `apiKey` and `context` are all required — there is no implicit default host.

### Scope

Scope is a DNF selector: an outer OR of inner AND groups, written as an array of arrays
of **slash-separated** `key/value` paths. A bare string or a flat array is also accepted.

```ts
await memory.remember('...', { scopes: 'team/eng' });            // [['team/eng']]
await memory.remember('...', { scopes: ['team/eng', 'org/acme'] }); // OR
await memory.remember('...', { scopes: [['team/eng', 'org/acme']] }); // AND
```

`normaliseScope` (from `@surrealdb/langchain-core/memory`) converts loose input into the
canonical `string[][]`.

### Retriever and tools

```ts
import { AgentMemoryRetriever } from '@surrealdb/langchain/retrievers';
import {
	createAgentMemoryQueryTool,
	createAgentMemoryReflectTool,
} from '@surrealdb/langchain/tools';

const retriever = new AgentMemoryRetriever({
	client: memory,
	mode: 'hybrid_graph',
	k: 8,
});

const tools = [
	createAgentMemoryQueryTool({ client: memory }),   // agent_memory_query
	createAgentMemoryReflectTool({ client: memory }), // agent_memory_reflect
];
```

Both tools return `content_and_artifact`: the query tool's artifact is the retrieved
`Document[]`, the reflect tool's is the full reflection response. Either accepts a plain
config object instead of a client, resolved via `resolveAgentMemory`.

### LangGraph store

`AgentMemoryStore` is a read-only `BaseStore` over Agent Memory.

```ts
import { AgentMemoryStore } from '@surrealdb/langgraph/memory_store';

const store = new AgentMemoryStore({ client: memory });
await store.get(['Person'], 'tobie');            // → entities.get
await store.search([], { query: 'who is tobie?' }); // → recall
```

| Method | Backed by | Supported |
| --- | --- | --- |
| `get` | `entities.get` | yes |
| `search` | `recall` | yes (requires `query`) |
| `put` / `delete` | — | throws |
| `listNamespaces` | — | throws |

Recall has no namespace dimension, so `search` cannot simply honour a
`namespacePrefix`. `namespaceMode` decides what happens when you pass one:

| Mode | Behaviour |
| --- | --- |
| `'error'` (default) | Throws, rather than returning unscoped hits |
| `'ignore'` | Searches everything and reports `namespace: []` |
| `'lens'` | Maps the namespace onto a scope lens — a real server-side narrowing |

Flat `filter` values become `key=value` label constraints; operator filters throw.
`offset` is applied client-side over an over-fetch. Search hits carry no timestamps —
`MemoryHitJson` has none — so `createdAt` / `updatedAt` are the epoch.

### Errors

```ts
import {
	AgentMemoryNotFoundError,
	AgentMemoryRateLimitError,
} from '@surrealdb/langchain-core';
```

| Class | HTTP |
| --- | --- |
| `AgentMemoryError` | base |
| `AgentMemoryAuthError` | 401 |
| `AgentMemoryScopeError` | 403 |
| `AgentMemoryNotFoundError` | 404 |
| `AgentMemoryValidationError` | 400, 422 |
| `AgentMemoryRateLimitError` | 429 (with `retryAfter`) |
| `AgentMemoryServerError` | 5xx |
| `AgentMemoryConnectionError` | network / timeout (status `0`) |
| `AgentMemoryCancelledError` | caller aborted via `signal` (status `0`) |

Every error carries `status`, `title`, `detail`, `type`, `instance` and `extensions`
parsed from an RFC 7807 problem body when present.

> `client.onBehalfOf(principalId)` still sends the `X-Spectron-On-Behalf-Of` header —
> that name is fixed upstream, so proxy or WAF rules keyed on it are unaffected by the
> rebrand.

---

## Migrating from 0.1.x

0.2.0 is a clean break: there are no deprecated aliases, and the old names are gone.

### Renamed exports

| 0.1.x | 0.2.0 |
| --- | --- |
| `VectorStore` | `SurrealDBVectorStore` |
| `ChatModel` | `SurrealDBChatModel` |
| `Store` | `SurrealDBStore` |
| `CheckpointSaver` | `SurrealDBSaver` |
| `Spectron` | `AgentMemory` |
| `SpectronError` and the other `Spectron*Error`s | `AgentMemoryError` / `AgentMemory*Error` |
| `SpectronOptions` / `SpectronConfig` | `AgentMemoryOptions` / `AgentMemoryConfig` |
| `SpectronMemoryCategory` | `AgentMemoryCategory` |
| `resolveSpectron` / `SpectronClientConfig` | `resolveAgentMemory` / `AgentMemoryClientConfig` |
| `SpectronRetriever` | `AgentMemoryRetriever` |
| `SpectronQueryTool` / `SpectronReflectTool` (classes) | `createAgentMemoryQueryTool` / `createAgentMemoryReflectTool` (factories) |
| `QueryTool` / `RecordTool` (classes) | `createQueryTool` / `createRecordTool` (factories) |
| `SpectronStore` | `AgentMemoryStore` (constructor key `spectron:` → `client:`) |

### Renamed subpaths and environment

| 0.1.x | 0.2.0 |
| --- | --- |
| `@surrealdb/langchain-core/spectron` | `@surrealdb/langchain-core/memory` |
| `@surrealdb/langgraph/spectron_store` | `@surrealdb/langgraph/memory_store` |
| `SPECTRON_ENDPOINT` / `SPECTRON_API_KEY` / `SPECTRON_CONTEXT` | `AGENT_MEMORY_ENDPOINT` / `AGENT_MEMORY_API_KEY` / `AGENT_MEMORY_CONTEXT` |
| tool names `spectron_query` / `spectron_reflect` | `agent_memory_query` / `agent_memory_reflect` |

### Behaviour changes

- **LangChain v1 is required.** `@langchain/core` v0.3 is no longer supported; the two
  adapter packages previously declared ranges that could not be satisfied together.
- **Vector store ids round-trip.** `addDocuments` now returns the bare id part and
  `delete({ ids })` accepts exactly that. In 0.1.x the two used different escapings and
  neither matched what was stored, so `delete({ ids })` silently deleted nothing.
- **Similarity, not distance.** `similaritySearchWithScore` returns a score where higher
  is better. Pass `scoreMode: 'distance'` to keep the old numbers.
- **`idField` is gone** from the vector store — SurrealDB's primary key is always `id`.
- **`indexType: 'mtree'` is gone.** SurrealDB v3 removed MTREE; `DEFINE INDEX … MTREE`
  is a parse error. Use `hnsw` (default) or `diskann`.
- **`HybridRetriever` rejects `graphEdges`** — see the note above.
- **`AgentMemoryStore.search` rejects a namespace prefix by default.** Set
  `namespaceMode: 'ignore'` for the old (unscoped) behaviour, or `'lens'` to scope for real.
- **Filter keys are escaped as identifiers**, so a key containing SurrealQL no longer
  reaches the query as an expression. A key like `tags[0]` is now a literal field name.
- **Tools return `content_and_artifact`.** `tool.invoke(args)` still gives a string;
  invoke with a tool call to get a `ToolMessage` whose `artifact` holds the rows.
- **`lc_namespace` changed** for the memory retriever, so a runnable serialized under the
  old namespace will not deserialize.
- **`zod` is now a peer dependency** (`^3.25.76 || ^4`).

---

## Local development

```bash
bun install
docker compose up -d            # SurrealDB v3 on :8000
bun run build
bun run typecheck
bun run typecheck:examples
bun run test
bun run test:integration
```

## License

Apache-2.0
