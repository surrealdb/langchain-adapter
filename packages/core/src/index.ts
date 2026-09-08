export type {
	AgentMemoryOptions,
	AgentMemoryOptions as AgentMemoryConfig,
	DocumentStatus as AgentMemoryDocumentStatus,
	MemoryCategory as AgentMemoryCategory,
	QueryMode as AgentMemoryQueryMode,
	TurnRole as AgentMemoryTurnRole,
} from '@surrealdb/memory';
export {
	AgentMemory,
	AgentMemoryError,
	AuthError as AgentMemoryAuthError,
	CancelledError as AgentMemoryCancelledError,
	ConnectionError as AgentMemoryConnectionError,
	NotFoundError as AgentMemoryNotFoundError,
	RateLimitError as AgentMemoryRateLimitError,
	ScopeError as AgentMemoryScopeError,
	ServerError as AgentMemoryServerError,
	ValidationError as AgentMemoryValidationError,
} from '@surrealdb/memory';
export { toBytes } from './bytes.js';
export {
	RecordId,
	resolveClient,
	SurrealDBClient,
	type SurrealTransaction,
} from './client.js';
export {
	isTokenConfig,
	isUrlConfig,
	type SurrealDBBaseConfig,
	type SurrealDBStoreConfig,
	type SurrealDBTokenConfig,
	type SurrealDBUrlConfig,
} from './config.js';
export {
	type TranslatedFilter,
	type TranslateFilterOptions,
	translateFilter,
} from './filter.js';
export {
	escapeIdent,
	isRoundTrippableId,
	recordIdToString,
	toRecordId,
} from './record.js';
export {
	explicitDistance,
	knnPredicate,
	type VectorQueryOptions,
} from './vector_query.js';
export {
	assertCount,
	assertIdent,
	compactRow,
	type DefineVectorIndexOptions,
	type DistanceStrategy,
	defineTable,
	defineVectorIndex,
	type VectorIndexType,
} from './schema.js';
export {
	type AgentMemoryClientConfig,
	resolveAgentMemory,
} from './memory_helpers.js';
