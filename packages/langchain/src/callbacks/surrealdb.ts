import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import {
	type BaseMessage,
	mapChatMessagesToStoredMessages,
} from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import {
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const CHAT_INVOCATIONS_TABLE = 'chat_invocations';

export interface SurrealDBChatCallbackHandlerArgs {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	tableName?: string;
	/** Correlates rows belonging to one conversation. */
	threadId?: string;
	/** Called when persistence fails. Defaults to a console warning. */
	onPersistError?: (err: unknown) => void;
	skipInitSchema?: boolean;
	skipVersionCheck?: boolean;
}

/**
 * Tees chat-model invocations into SurrealDB from the callback stream.
 *
 * This is the recommended way to persist LLM traffic. Unlike wrapping a model,
 * it leaves the model itself untouched — `bindTools`, `withStructuredOutput`,
 * streaming, caching and tool loops all keep working, and it composes with
 * LangGraph agents:
 *
 * ```ts
 * const model = new ChatOpenAI({ model: 'gpt-4.1-mini' }).withConfig({
 *   callbacks: [new SurrealDBChatCallbackHandler({ surreal })],
 * });
 * ```
 *
 * Persistence failures never fail the run — an LLM call that succeeded should
 * not be reported as failed because a write did not land.
 */
export class SurrealDBChatCallbackHandler extends BaseCallbackHandler {
	name = 'SurrealDBChatCallbackHandler';

	readonly client: SurrealDBClient;
	readonly tableName: string;
	readonly threadId?: string;
	private readonly onPersistError: (err: unknown) => void;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private setupDone = false;
	/** Messages seen at start, keyed by runId, so `handleLLMEnd` can pair them. */
	private readonly pending = new Map<string, BaseMessage[]>();

	constructor(args: SurrealDBChatCallbackHandlerArgs) {
		super();
		this.tableName = assertIdent(
			args.tableName ?? CHAT_INVOCATIONS_TABLE,
			'table',
		);
		this.threadId = args.threadId;
		this.onPersistError =
			args.onPersistError ??
			((err) => {
				console.warn(
					'[SurrealDBChatCallbackHandler] persist failed:',
					err,
				);
			});
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
					{ name: 'thread_id', type: 'TYPE option<string>' },
					{ name: 'run_id', type: 'TYPE string' },
					{ name: 'llm_type', type: 'TYPE option<string>' },
					{ name: 'messages', type: 'TYPE string' },
					{ name: 'result', type: 'TYPE option<string>' },
					{ name: 'error', type: 'TYPE option<string>' },
					{
						name: 'created_at',
						type: 'TYPE datetime DEFAULT time::now()',
					},
				]),
			);
		}
		this.setupDone = true;
	}

	override async handleChatModelStart(
		_llm: Serialized,
		messages: BaseMessage[][],
		runId: string,
	): Promise<void> {
		this.pending.set(runId, messages.flat());
	}

	override async handleLLMEnd(
		output: LLMResult,
		runId: string,
	): Promise<void> {
		const messages = this.pending.get(runId);
		this.pending.delete(runId);
		if (!messages) return; // a plain LLM run, not a chat model
		await this.persist(runId, messages, { result: output });
	}

	override async handleLLMError(err: unknown, runId: string): Promise<void> {
		const messages = this.pending.get(runId);
		this.pending.delete(runId);
		if (!messages) return;
		await this.persist(runId, messages, {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	private async persist(
		runId: string,
		messages: BaseMessage[],
		outcome: { result?: LLMResult; error?: string },
	): Promise<void> {
		try {
			await this.setup();
			await this.client.execute(
				`CREATE type::table($table) CONTENT $row`,
				{
					table: this.tableName,
					row: compactRow({
						thread_id: this.threadId,
						run_id: runId,
						messages: JSON.stringify(
							mapChatMessagesToStoredMessages(messages),
						),
						result: outcome.result
							? JSON.stringify(outcome.result)
							: undefined,
						error: outcome.error,
					}),
				},
			);
		} catch (persistErr) {
			this.onPersistError(persistErr);
		}
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}
}
