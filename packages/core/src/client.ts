import { RecordId, Surreal, type SurrealTransaction } from 'surrealdb';
import {
	isTokenConfig,
	isUrlConfig,
	type SurrealDBStoreConfig,
} from './config.js';

export type { SurrealTransaction };
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
		} else {
			// Falling through used to leave the client marked connected but
			// unauthenticated, so the first query failed somewhere far from
			// the cause.
			const keys = Object.keys(this.config ?? {});
			throw new Error(
				`SurrealDBClient: unusable connection config. Expected ` +
					`{ url, username, password } or { url, token }, but got ` +
					`{ ${keys.join(', ')} }.`,
			);
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
	 *
	 * Uses the SDK's `beginTransaction()` so all queries issued through
	 * the passed handle participate in the same server-side transaction.
	 * Plain string `BEGIN; …; COMMIT;` does not work across separate
	 * RPC calls — that's why the callback receives a transaction handle
	 * rather than the raw `Surreal` instance.
	 */
	async tx<T>(fn: (tx: SurrealTransaction) => Promise<T>): Promise<T> {
		const tx = await this.db.beginTransaction();
		try {
			const result = await fn(tx);
			await tx.commit();
			return result;
		} catch (err) {
			try {
				await tx.cancel();
			} catch {
				// already rolled back / disconnected — surface the original
			}
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

/**
 * Accept either a shared client or the config to build one, and report which
 * it was — an owned client is the caller's to close, a passed-in one is not.
 *
 * Every adapter in these packages takes `surreal: SurrealDBClient |
 * SurrealDBStoreConfig`, so this is the one place that distinction is made.
 */
export function resolveClient(
	surreal: SurrealDBClient | SurrealDBStoreConfig,
): { client: SurrealDBClient; owned: boolean } {
	return surreal instanceof SurrealDBClient
		? { client: surreal, owned: false }
		: { client: new SurrealDBClient(surreal), owned: true };
}
