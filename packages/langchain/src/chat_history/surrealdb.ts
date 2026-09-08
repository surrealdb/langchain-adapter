import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import {
	type BaseMessage,
	mapChatMessagesToStoredMessages,
	mapStoredMessagesToChatMessages,
	type StoredMessage,
} from '@langchain/core/messages';
import {
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const CHAT_MESSAGES_TABLE = 'langchain_chat_messages';

export interface SurrealDBChatMessageHistoryArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	/** Conversation this history belongs to. */
	sessionId: string;
	tableName?: string;
	skipInitSchema?: boolean;
	skipVersionCheck?: boolean;
}

interface MessageRow {
	type: string;
	data: string;
	seq: number;
}

/**
 * SurrealDB-backed chat message history.
 *
 * Messages round-trip through `mapChatMessagesToStoredMessages` /
 * `mapStoredMessagesToChatMessages`, so v1 content blocks, tool calls, ids
 * and response metadata survive — the stored `data` is the message's full
 * `lc_kwargs`, kept as a JSON string so SurrealDB never coerces the nested
 * block structure.
 *
 * Two limits worth knowing: a `RemoveMessage`, or any type outside
 * `human | ai | system | function | tool | generic`, throws on read; and an
 * `AIMessageChunk` comes back as a plain `AIMessage`.
 *
 * For LangGraph, prefer `SurrealDBSaver` — a checkpointer already persists
 * the message list as graph state, and using both duplicates it.
 */
export class SurrealDBChatMessageHistory extends BaseListChatMessageHistory {
	override lc_namespace = ['langchain', 'stores', 'message', 'surrealdb'];

	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly sessionId: string;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;

	constructor(args: SurrealDBChatMessageHistoryArgs) {
		super();
		this.tableName = assertIdent(
			args.tableName ?? CHAT_MESSAGES_TABLE,
			'table',
		);
		this.sessionId = args.sessionId;
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
					{ name: 'session_id', type: 'TYPE string' },
					{ name: 'seq', type: 'TYPE int' },
					{ name: 'type', type: 'TYPE string' },
					{ name: 'data', type: 'TYPE string' },
					// Denormalised so callers can add a full-text index.
					{ name: 'text', type: 'TYPE option<string>' },
					{
						name: 'created_at',
						type: 'TYPE datetime DEFAULT time::now()',
					},
				]),
			);
			await this.client.execute(
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_session_seq_idx ` +
					`ON ${this.tableName} FIELDS session_id, seq;`,
			);
		}
		this.setupDone = true;
	}

	override async getMessages(): Promise<BaseMessage[]> {
		await this.setup();
		const rows = await this.client.queryAll<MessageRow>(
			`SELECT type, data, seq FROM type::table($table) ` +
				`WHERE session_id = $sid ORDER BY seq ASC`,
			{ table: this.tableName, sid: this.sessionId },
		);
		return mapStoredMessagesToChatMessages(
			rows.map(
				(r) =>
					({
						type: r.type,
						data: JSON.parse(r.data),
					}) as StoredMessage,
			),
		);
	}

	override async addMessage(message: BaseMessage): Promise<void> {
		await this.addMessages([message]);
	}

	override async addMessages(messages: BaseMessage[]): Promise<void> {
		if (messages.length === 0) return;
		await this.setup();
		const stored = mapChatMessagesToStoredMessages(messages);

		// Read-max-then-insert inside one transaction: two writers appending
		// to the same session would otherwise pick the same `seq`.
		await this.client.tx(async (tx) => {
			const result = await tx
				.query<[{ next: number | null }[]]>(
					`SELECT VALUE { next: math::max(seq) } ` +
						`FROM type::table($table) WHERE session_id = $sid ` +
						`GROUP ALL`,
					{ table: this.tableName, sid: this.sessionId },
				)
				.collect();
			// An empty session aggregates to `-Infinity`, not NONE — so this
			// needs a finiteness check, not a null check.
			const highest = result[0]?.[0]?.next;
			const base = (Number.isFinite(highest) ? (highest as number) : -1) + 1;

			// `INSERT INTO` needs a literal table name — `type::table()` is
			// not accepted there. `this.tableName` is assertIdent-validated.
			await tx
				.query(`INSERT INTO ${this.tableName} $rows`, {
					rows: stored.map((s, i) =>
						compactRow({
							session_id: this.sessionId,
							seq: base + i,
							type: s.type,
							data: JSON.stringify(s.data),
							text: messages[i]?.text,
						}),
					),
				})
				.collect();
		});
	}

	override async clear(): Promise<void> {
		await this.setup();
		await this.client.execute(
			`DELETE FROM type::table($table) WHERE session_id = $sid`,
			{ table: this.tableName, sid: this.sessionId },
		);
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}
}
