export {
	RecordId,
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
	assertIdent,
	type DefineVectorIndexOptions,
	type DistanceStrategy,
	defineTable,
	defineVectorIndex,
	type VectorIndexType,
} from './schema.js';
export {
	AuthError as SpectronAuthError,
	NotFoundError as SpectronNotFoundError,
	RateLimitError as SpectronRateLimitError,
	ScopeError as SpectronScopeError,
	ServerError as SpectronServerError,
	Spectron,
	SpectronClient,
	type SpectronConfig,
	SpectronError,
	ValidationError as SpectronValidationError,
} from './spectron/index.js';
export type {
	DocumentStatus as SpectronDocumentStatus,
	IngestProfile as SpectronIngestProfile,
	MemoryCategory as SpectronMemoryCategory,
	QueryMode as SpectronQueryMode,
	TurnRole as SpectronTurnRole,
} from './spectron/models.js';
