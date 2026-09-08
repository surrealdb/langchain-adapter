import {
	BaseCache,
	deserializeStoredGeneration,
	serializeGeneration,
} from '@langchain/core/caches';
import type { StoredGeneration } from '@langchain/core/messages';
import type { Generation } from '@langchain/core/outputs';
import {
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
	toRecordId,
} from '@surrealdb/langchain-core';

const LLM_CACHE_TABLE = 'langchain_llm_cache';

export interface SurrealDBLLMCacheArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	/** Seconds before an entry stops being served. Omit to keep forever. */
	ttlSeconds?: number;
	/**
	 * Persist the prompt text alongside the cached generations. Off by
	 * default: prompts routinely contain user data, and the cache does not
	 * need them to function.
	 */
	storePrompt?: boolean;
	skipInitSchema?: boolean;
	skipVersionCheck?: boolean;
}

interface CacheRow {
	generations: string;
}

/**
 * SurrealDB-backed LLM response cache.
 *
 * ```ts
 * const model = new ChatOpenAI({
 *   cache: new SurrealDBLLMCache({ surreal, ttlSeconds: 3600 }),
 * });
 * ```
 *
 * `BaseChatModel.generate()` drives `lookup`/`update`; nothing else is needed.
 */
export class SurrealDBLLMCache extends BaseCache<Generation[]> {
	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly ttlSeconds?: number;
	readonly storePrompt: boolean;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBLLMCacheArgs) {
		super();
		this.tableName = assertIdent(args.tableName ?? LLM_CACHE_TABLE, 'table');
		this.ttlSeconds = args.ttlSeconds;
		this.storePrompt = args.storePrompt ?? false;
		this.skipInitSchema = args.skipInitSchema ?? false;
		this.skipVersionCheck = args.skipVersionCheck ?? false;
		const { client, owned } = resolveClient(args.surreal);
		this.client = client;
		this.ownsClient = owned;
	}

	private async setup(): Promise<void> {
		if (this.setupDone) return;
		await this.client.connect();
		if (!this.skipVersionCheck) await this.client.assertServerVersion();
		if (!this.skipInitSchema) {
			await this.client.execute(
				defineTable(this.tableName, [
					// A JSON string, not an object column: cache rows are never
					// queried by content, and this keeps SurrealDB out of the
					// business of coercing nested generation structures.
					{ name: 'generations', type: 'TYPE string' },
					{ name: 'llm_key', type: 'TYPE string' },
					{ name: 'prompt', type: 'TYPE option<string>' },
					{
						name: 'created_at',
						type: 'TYPE datetime DEFAULT time::now()',
					},
					{ name: 'expires_at', type: 'TYPE option<datetime>' },
				]),
			);
		}
		this.setupDone = true;
	}

	/** The sha256 the base class derives from (prompt, llmKey) — ident-safe. */
	private key(prompt: string, llmKey: string) {
		return toRecordId(this.tableName, this.keyEncoder(prompt, llmKey));
	}

	override async lookup(
		prompt: string,
		llmKey: string,
	): Promise<Generation[] | null> {
		await this.setup();
		const row = await this.client.queryOne<CacheRow>(
			`SELECT generations FROM $id ` +
				`WHERE expires_at IS NONE OR expires_at > time::now()`,
			{ id: this.key(prompt, llmKey) },
		);
		if (!row) return null;
		const stored = JSON.parse(row.generations) as StoredGeneration[];
		return stored.map((g) => deserializeStoredGeneration(g));
	}

	override async update(
		prompt: string,
		llmKey: string,
		value: Generation[],
	): Promise<void> {
		await this.setup();
		await this.client.execute(`UPSERT $id CONTENT $row`, {
			id: this.key(prompt, llmKey),
			row: compactRow({
				generations: JSON.stringify(value.map(serializeGeneration)),
				llm_key: llmKey,
				prompt: this.storePrompt ? prompt : undefined,
				expires_at:
					this.ttlSeconds === undefined
						? undefined
						: new Date(Date.now() + this.ttlSeconds * 1000),
			}),
		});
	}

	/** Drop every cached entry. */
	async clear(): Promise<void> {
		await this.setup();
		await this.client.execute(`DELETE FROM type::table($table)`, {
			table: this.tableName,
		});
	}

	/** Delete entries whose TTL has elapsed. Expired rows are never served. */
	async sweepExpired(): Promise<void> {
		await this.setup();
		await this.client.execute(
			`DELETE FROM type::table($table) ` +
				`WHERE expires_at IS NOT NONE AND expires_at <= time::now()`,
			{ table: this.tableName },
		);
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}
}
