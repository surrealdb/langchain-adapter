export type {
	DocumentStatus as SpectronDocumentStatus,
	MemoryCategory as SpectronMemoryCategory,
	QueryMode as SpectronQueryMode,
	SpectronOptions,
	SpectronOptions as SpectronConfig,
	TurnRole as SpectronTurnRole,
} from '@surrealdb/spectron';
export {
	AuthError as SpectronAuthError,
	ConnectionError as SpectronConnectionError,
	NotFoundError as SpectronNotFoundError,
	RateLimitError as SpectronRateLimitError,
	ScopeError as SpectronScopeError,
	ServerError as SpectronServerError,
	Spectron,
	SpectronError,
	ValidationError as SpectronValidationError,
} from '@surrealdb/spectron';
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
	resolveSpectron,
	type SpectronClientConfig,
} from './spectron_helpers.js';
