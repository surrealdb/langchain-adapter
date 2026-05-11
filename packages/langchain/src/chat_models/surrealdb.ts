import {
	type BaseChatModelCallOptions,
	type BaseChatModelParams,
	BaseChatModel as BaseLangChainChatModel,
} from '@langchain/core/language_models/chat_models';
import type {
	BaseLanguageModelCallOptions,
	BaseLanguageModelInput,
} from '@langchain/core/language_models/base';
import {
	AIMessageChunk,
	type BaseMessage,
} from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGeneration, ChatResult } from '@langchain/core/outputs';
import {
	assertIdent,
	defineTable,
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

export interface ChatModelArgs extends BaseChatModelParams {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
	/** The chat model that actually generates completions. */
	delegate: BaseLangChainChatModel;
	/** Table to persist invocations to. Default: `chat_invocations`. */
	tableName?: string;
	/** Optional grouping label persisted with each row. */
	threadId?: string;
	/** Skip schema bootstrap. */
	skipInitSchema?: boolean;
	/** Skip the SurrealDB v3 server version check. */
	skipVersionCheck?: boolean;
}

/**
 * `BaseChatModel` wrapper that delegates generation to another chat
 * model and tees every invocation (input messages + result) to a
 * SurrealDB table.
 *
 * The delegate is unchanged — bind tools, set temperature etc. on it
 * before passing it in.
 */
export class ChatModel extends BaseLangChainChatModel {
	override lc_namespace = ['langchain', 'chat_models', 'surrealdb'];

	readonly client: SurrealDBClient;
	readonly delegate: BaseLangChainChatModel;
	readonly tableName: string;
	readonly threadId: string | undefined;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private initialised = false;

	constructor(args: ChatModelArgs) {
		super(args);
		this.delegate = args.delegate;
		this.tableName = assertIdent(
			args.tableName ?? 'chat_invocations',
			'table',
		);
		this.threadId = args.threadId;
		this.skipInitSchema = args.skipInitSchema ?? false;
		this.skipVersionCheck = args.skipVersionCheck ?? false;

		if (args.surreal instanceof SurrealDBClient) {
			this.client = args.surreal;
			this.ownsClient = false;
		} else {
			this.client = new SurrealDBClient(args.surreal);
			this.ownsClient = true;
		}
	}

	override _llmType(): string {
		return `surrealdb:${this.delegate._llmType()}`;
	}

	async initialize(): Promise<void> {
		if (this.initialised) return;
		await this.client.connect();
		if (!this.skipVersionCheck) {
			await this.client.assertServerVersion();
		}
		if (!this.skipInitSchema) {
			const ddl = defineTable(this.tableName, [
				{ name: 'thread_id', type: 'TYPE option<string>' },
				{ name: 'llm_type', type: 'TYPE string' },
				{ name: 'messages', type: 'TYPE array FLEXIBLE' },
				{ name: 'result', type: 'TYPE object FLEXIBLE' },
				{
					name: 'created_at',
					type: 'TYPE datetime DEFAULT time::now()',
				},
			]);
			await this.client.execute(ddl);
			await this.client.execute(
				`DEFINE INDEX IF NOT EXISTS ${this.tableName}_thread_idx ` +
					`ON ${this.tableName} FIELDS thread_id, created_at;`,
			);
		}
		this.initialised = true;
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	override async _generate(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		await this.initialize();
		const result = await this.delegate._generate(
			messages,
			options as BaseChatModelCallOptions,
			runManager,
		);
		await this.persist(messages, result);
		return result;
	}

	override async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	) {
		await this.initialize();
		const chunks: AIMessageChunk[] = [];
		const stream = this.delegate._streamResponseChunks(
			messages,
			options as BaseChatModelCallOptions,
			runManager,
		);
		for await (const chunk of stream) {
			chunks.push(chunk.message);
			yield chunk;
		}
		const finalText = chunks.map((c) => c.text ?? '').join('');
		await this.persist(messages, {
			generations: [
				{
					text: finalText,
					message: chunks[0] ?? new AIMessageChunk(finalText),
				} as ChatGeneration,
			],
		});
	}

	override async invoke(
		input: BaseLanguageModelInput,
		options?: BaseLanguageModelCallOptions,
	) {
		await this.initialize();
		return super.invoke(input, options);
	}

	private async persist(
		messages: BaseMessage[],
		result: ChatResult,
	): Promise<void> {
		await this.client.execute(
			`CREATE ${this.tableName} CONTENT $row`,
			{
				row: {
					thread_id: this.threadId,
					llm_type: this.delegate._llmType(),
					messages: messages.map((m) => m.toDict()),
					result: serialiseResult(result),
				},
			},
		);
	}
}

function serialiseResult(result: ChatResult): Record<string, unknown> {
	return {
		generations: result.generations.map((g) => ({
			text: g.text,
			message: g.message?.toDict?.() ?? null,
		})),
		llmOutput: result.llmOutput ?? null,
	};
}
