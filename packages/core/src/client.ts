import { RecordId, Surreal } from 'surrealdb';
import {
	isTokenConfig,
	isUrlConfig,
	type SurrealDBStoreConfig,
} from './config.js';

export { RecordId };

/**
 * Thin wrapper around the official SurrealDB SDK that handles connection
 * lifecycle, namespace/database selection and a few query helpers shared
 * by the LangChain and LangGraph adapter packages.
 */
export class SurrealDBClient {
	readonly db: Surreal;
	private connected = false;
	readonly namespace: string;
	readonly database: string;
	private readonly config: SurrealDBStoreConfig;

	constructor(config: SurrealDBStoreConfig) {
		this.config = config;
		this.namespace = config.namespace ?? 'langchain';
		this.database = config.database ?? 'langchain';
		this.db = new Surreal();
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		if (isUrlConfig(this.config)) {
			await this.db.connect(this.config.url);
			await this.db.signin({
				username: this.config.username,
				password: this.config.password,
			});
		} else if (isTokenConfig(this.config)) {
			await this.db.connect(this.config.url);
			await this.db.authenticate(this.config.token);
		}

		await this.db.use({
			namespace: this.namespace,
			database: this.database,
		});

		this.connected = true;
	}

	async close(): Promise<void> {
		if (this.connected) {
			await this.db.close();
			this.connected = false;
		}
	}

	async queryAll<T>(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<T[]> {
		const results = await this.db.query<[T[]]>(surql, bindings);
		return (results[0] as T[]) ?? [];
	}

	async queryOne<T>(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<T | null> {
		const rows = await this.queryAll<T>(surql, bindings);
		return rows[0] ?? null;
	}

	async queryMany<T extends unknown[]>(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		const results = await this.db.query<T>(surql, bindings);
		return results as unknown as T;
	}

	async execute(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<void> {
		await this.db.query(surql, bindings);
	}

	/**
	 * Run a function inside a SurrealQL transaction. The transaction is
	 * cancelled (rolled back) if the function throws.
	 */
	async tx<T>(fn: (db: Surreal) => Promise<T>): Promise<T> {
		await this.db.query('BEGIN TRANSACTION');
		try {
			const result = await fn(this.db);
			await this.db.query('COMMIT TRANSACTION');
			return result;
		} catch (err) {
			await this.db.query('CANCEL TRANSACTION');
			throw err;
		}
	}

	/**
	 * Assert the connected SurrealDB server is v3.x. Throws otherwise.
	 * The adapter requires v3 features (HNSW vector index, `bytes` type,
	 * `<|k,dist|>` kNN operator).
	 */
	async assertServerVersion(): Promise<void> {
		const info = await this.db.version();
		const version = info.version.replace(/^surrealdb-/, '');
		const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
		if (major < 3) {
			throw new Error(
				`@surrealdb/langchain-* requires SurrealDB v3 or higher, ` +
					`but the connected server reports version "${version}". ` +
					`Upgrade your SurrealDB instance to v3.x.`,
			);
		}
	}
}
