import {
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const DEFAULT_URL = process.env.SURREALDB_URL ?? 'ws://localhost:8000';
const DEFAULT_USER = process.env.SURREALDB_USER ?? 'root';
const DEFAULT_PASS = process.env.SURREALDB_PASS ?? 'root';

export function makeConfig(suffix: string): SurrealDBStoreConfig {
	return {
		url: DEFAULT_URL,
		username: DEFAULT_USER,
		password: DEFAULT_PASS,
		namespace: 'langgraph_test',
		database: `${suffix}_${Date.now()}`,
	};
}

export async function freshClient(suffix: string): Promise<SurrealDBClient> {
	const c = new SurrealDBClient(makeConfig(suffix));
	await c.connect();
	return c;
}
