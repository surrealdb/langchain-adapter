# @surrealdb/langgraph

## 0.2.0 — 2026-09-08

### Breaking

- **LangChain v1 required.** `@langchain/core` moves to `^1.2.9`; v0.3 is no longer
  supported. Previously `@surrealdb/langchain` peered `>=0.3.0 <1.0.0` while
  `@surrealdb/langgraph` built against v1, so the two could not be installed together
  with `@langchain/langgraph@1.x`.
- `@langchain/langgraph-checkpoint` moves to `^1.1.5`.
- Renamed exports: `CheckpointSaver` → `SurrealDBSaver`, `Store` →
  `SurrealDBStore`, `SpectronStore` → `AgentMemoryStore`.
- The `./spectron_store` export subpath is now `./memory_store`, and
  `AgentMemoryStore`'s constructor key `spectron` is now `client`.
- `AgentMemoryStore.search` rejects a non-empty `namespacePrefix` by default rather
  than returning unscoped hits labelled as scoped. `namespaceMode: 'ignore'` restores
  the old behaviour; `'lens'` maps the namespace onto a real scope lens.

### Added

- `SurrealDBNodeCache` — a `BaseCache` backing LangGraph v1's per-node
  `cachePolicy`, via `compile({ cache })`.
- `SurrealDBSaver.list()` supports cross-thread and cross-namespace listing, honours
  `checkpoint_id`, and populates `pendingWrites`.
- `SurrealDBSaver` gains `skipInitSchema`, matching the store and vector store.
- `SurrealDBStore` gains `indexType`, `ef` and `strictSearch`; its filters now
  support `$in`, `$nin` and `$exists` via the shared translator.
- `AgentMemoryStore.search` maps flat filters onto label constraints and applies
  `offset`.

### Fixed

- **`putWrites` had its conflict policy inverted.** Upstream leaves an existing
  regular write alone and lets the special channels (`__error__`, `__scheduled__`,
  `__interrupt__`, `__resume__`) overwrite; this did the reverse, so an interrupt
  resumed twice kept the stale payload while a replayed task clobbered good writes.
- `list()` required both `thread_id` and `checkpoint_ns`, so listing across threads
  returned nothing and listing a thread silently restricted to the root namespace.
- `list()` returned no `pendingWrites`, so `getStateHistory()` reported no pending
  tasks.
- `listNamespaces` returned a namespace once per item it held instead of once.
- The store embedded search queries with `embedDocuments` instead of `embedQuery` —
  the wrong side of an asymmetric embedding model.
- Metadata and value filter keys were interpolated into SurrealQL unescaped.
- `AgentMemoryStore.batch` rejected every operation when any one failed, taking
  unrelated concurrent reads down with it — and `AsyncBatchedStore` coalesces
  concurrent calls, so mixed batches are the normal case.
- Checkpointer table names now go through `assertIdent` before reaching DDL.
- The store's class doc claimed `batch` ran in one transaction; it does not, and
  should not — `runPut` awaits the embedding provider.
