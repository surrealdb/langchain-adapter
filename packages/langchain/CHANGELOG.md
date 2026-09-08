# @surrealdb/langchain

## 0.2.0 — 2026-09-08

### Breaking

- **LangChain v1 required.** `@langchain/core` moves to `^1.2.9`; v0.3 is no longer
  supported. Previously `@surrealdb/langchain` peered `>=0.3.0 <1.0.0` while
  `@surrealdb/langgraph` built against v1, so the two could not be installed together
  with `@langchain/langgraph@1.x`.
- Renamed exports: `VectorStore` → `SurrealDBVectorStore`, `ChatModel` →
  `SurrealDBChatModel`, `SpectronRetriever` → `AgentMemoryRetriever`.
- Tools are now factories built on LangChain v1's `tool()`: `QueryTool` →
  `createQueryTool`, `RecordTool` → `createRecordTool`, `SpectronQueryTool` →
  `createAgentMemoryQueryTool`, `SpectronReflectTool` →
  `createAgentMemoryReflectTool`. All return `content_and_artifact`.
- Tool names `spectron_query` / `spectron_reflect` are now `agent_memory_query` /
  `agent_memory_reflect`.
- `similaritySearchWithScore` returns a **similarity** (higher is better), not a
  distance. `scoreMode: 'distance'` restores the old numbers.
- The vector store's `idField` option is gone — SurrealDB's primary key is always
  `id` — and `indexType: 'mtree'` is gone with MTREE itself.
- `HybridRetriever` throws on `graphEdges`; graph expansion never worked and is
  deferred rather than silently returning nothing.
- `zod` moves to a peer dependency (`^3.25.76 || ^4`).
- `lc_namespace` for the memory retriever is now
  `['langchain','retrievers','surrealdb','agent_memory']`.

### Added

- `SurrealDBRecordManager` — the LangChain indexing API (`index()`), so a vector
  store can be kept in sync with a source.
- `SurrealDBLLMCache` — an LLM response cache, with TTL. Prompts are not stored
  unless `storePrompt: true`.
- `SurrealDBChatMessageHistory` — `BaseListChatMessageHistory` preserving v1
  content blocks, tool calls, ids and response metadata.
- `SurrealDBChatCallbackHandler` — the recommended way to persist LLM traffic; it
  leaves the model untouched, so tool calling and structured output keep working.
- `maxMarginalRelevanceSearch` on the vector store, which also makes
  `asRetriever({ searchType: 'mmr' })` work.
- `SurrealDBChatModel` now forwards `bindTools`, `getLsParams`,
  `invocationParams`, `_combineLLMOutput`, `_modelType`, `getNumTokens`,
  `callKeys`, `disableStreaming` and the delegate's cache.

### Fixed

- **Custom record ids did not round-trip.** `addVectors` wrote one escaping,
  `delete` reconstructed another, and neither matched what was stored — so
  `delete({ ids })` silently removed nothing. Ids are now real `RecordId`s.
  The hand-rolled escape used `⧼⧽`; SurrealDB uses `⟨⟩`.
- The vector store never used its own index: every search, filtered or not, was a full
  scan. It now uses the kNN operator, with the filter pushed into the index traversal.
- Inserting a document whose id already exists errored; it now upserts, which is what
  `index({ forceUpdate: true })` needs.
- `_streamResponseChunks` persisted only the *first* chunk as the message while
  recording the full text. Chunks are now merged, and a consumer that breaks early
  still persists what it received.
- Persistence failures no longer turn a completed LLM call into a thrown one; they go
  to `onPersistError` (or set `strictPersistence: true`).
- `SurrealDBChatModel` could never be constructed: `BaseChatModel` calls
  `_llmType()` from a field initialiser during `super()`, before the delegate is
  assigned.
- `_llmType()` no longer prefixes the delegate's type, which broke LangSmith provider
  detection and the cache key.
- `createTool` declared a class per call, so `instanceof` never held.
- Searches project explicit columns instead of `SELECT *`, so a full embedding is no
  longer returned for every hit.
