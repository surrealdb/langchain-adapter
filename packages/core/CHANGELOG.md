# @surrealdb/langchain-core

## 0.2.0 — 2026-09-08

### Breaking

- **LangChain v1 required.** `@langchain/core` moves to `^1.2.9`; v0.3 is no longer
  supported. Previously `@surrealdb/langchain` peered `>=0.3.0 <1.0.0` while
  `@surrealdb/langgraph` built against v1, so the two could not be installed together
  with `@langchain/langgraph@1.x`.
- **Spectron is now SurrealDB Agent Memory.** The dependency moves from
  `@surrealdb/spectron` to `@surrealdb/memory`, and every re-export is renamed:
  `Spectron` → `AgentMemory`, `SpectronError` → `AgentMemoryError`,
  `SpectronOptions` → `AgentMemoryOptions`, `SpectronMemoryCategory` →
  `AgentMemoryCategory`, `resolveSpectron` → `resolveAgentMemory`,
  `SpectronClientConfig` → `AgentMemoryClientConfig`. The duplicate
  `SpectronConfig` alias is now `AgentMemoryConfig`.
- The `./spectron` export subpath is now `./memory`.
- Environment variables `SPECTRON_ENDPOINT` / `SPECTRON_API_KEY` /
  `SPECTRON_CONTEXT` are now `AGENT_MEMORY_*`. There is no fallback.
- `VectorIndexType` drops `'mtree'` and gains `'diskann'`. SurrealDB v3 removed
  MTREE — `DEFINE INDEX … MTREE` is a parse error — so the old option could only
  produce invalid DDL.
- `translateFilter` escapes each segment of a field reference. A filter key containing
  SurrealQL is now an identifier that matches nothing rather than an expression; a key
  like `tags[0]` is a literal field name.

### Added

- `toRecordId`, `recordIdToString`, `isRoundTrippableId` and a re-export of the
  SDK's `escapeIdent` — one place that defines how record ids round-trip.
- `knnPredicate` / `explicitDistance`: the correct kNN spelling per index type.
  SurrealDB v3 rejects the single-argument `<|k|>` outright, and `<|k,EF|>` against
  an unindexed field returns wrong results silently.
- `assertCount` for values interpolated into `LIMIT` / `START` / `k`.
- `compactRow`, which drops nullish fields — SurrealDB's `option<T>` accepts an
  absent field but rejects an explicit `NULL`.
- `resolveClient` and `toBytes`, both previously duplicated across the adapters.
- `AgentMemoryCancelledError`, new in the upstream SDK.

### Fixed

- `SurrealDBClient.connect()` threw nothing when the config matched neither the
  username/password nor the token shape: it marked itself connected and left the
  connection unauthenticated, so the failure surfaced on the first query.
