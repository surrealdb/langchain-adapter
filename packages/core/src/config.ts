export interface SurrealDBBaseConfig {
	namespace?: string;
	database?: string;
}

export interface SurrealDBUrlConfig extends SurrealDBBaseConfig {
	url: string;
	username: string;
	password: string;
}

export interface SurrealDBTokenConfig extends SurrealDBBaseConfig {
	url: string;
	token: string;
}

export type SurrealDBStoreConfig = SurrealDBUrlConfig | SurrealDBTokenConfig;

export function isUrlConfig(
	cfg: SurrealDBStoreConfig,
): cfg is SurrealDBUrlConfig {
	return 'username' in cfg && 'password' in cfg;
}

export function isTokenConfig(
	cfg: SurrealDBStoreConfig,
): cfg is SurrealDBTokenConfig {
	return 'token' in cfg && !('username' in cfg);
}
