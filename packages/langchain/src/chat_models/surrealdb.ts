import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type {
	BaseLanguageModelCallOptions,
	BaseLanguageModelInput,
} from '@langchain/core/language_models/base';
import {
	type BaseChatModelCallOptions,
	type BaseChatModelParams,
	BaseChatModel as BaseLangChainChatModel,
	type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import {
	AIMessageChunk,
	type BaseMessage,
	mapChatMessagesToStoredMessages,
} from '@langchain/core/messages';
import type { ChatGeneration, ChatResult, LLMResult } from '@langchain/core/outputs';
import { RunnableBinding } from '@langchain/core/runnables';
import {
	assertIdent,
	compactRow,
	defineTable,
	resolveClient,
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

export interface SurrealDBChatModelArgs extends BaseChatModelParams {
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
	/**
	 * Called when persisting an invocation fails. Defaults to a console
	 * warning: a completed LLM call should not be reported as failed just
	 * because the audit write did not land.
	 */
	onPersistError?: (err: unknown) => void;
	/** Make persistence failures fatal instead. Default `false`. */
	strictPersistence?: boolean;
	/** Adopt the delegate's LLM cache. Default `true`. */
	inheritCache?: boolean;
}

/**
 * `BaseChatModel` wrapper that delegates generation to another chat model and
 * tees every invocation (input messages + result) to a SurrealDB table.
 *
 * Prefer {@link SurrealDBChatCallbackHandler} unless you specifically need a
 * `BaseChatModel`-shaped object: a callback handler persists the same data
 * without standing between the caller and the model, so nothing can be lost
 * in the forwarding.
 *
 * This wrapper forwards tool binding, structured output and the metadata the
 * tracing and caching layers read, so the delegate's capabilities survive.
 */
export class SurrealDBChatModel extends BaseLangChainChatModel {
	override lc_namespace = ['langchain', 'chat_models', 'surrealdb'];

	readonly client: SurrealDBClient;
	readonly delegate: BaseLangChainChatModel;
	readonly tableName: string;
	readonly threadId: string | undefined;
	private readonly skipInitSchema: boolean;
	private readonly skipVersionCheck: boolean;
	private readonly ownsClient: boolean;
	private readonly onPersistError: (err: unknown) => void;
	private readonly strictPersistence: boolean;
	private initialised = false;

	constructor(args: SurrealDBChatModelArgs) {
		super(args);
		this.delegate = args.delegate;
		this.tableName = assertIdent(
			args.tableName ?? 'chat_invocations',
			'table',
		);
		this.threadId = args.threadId;
		this.skipInitSchema = args.skipInitSchema ?? false;
		this.skipVersionCheck = args.skipVersionCheck ?? false;
		this.strictPersistence = args.strictPersistence ?? false;
		this.onPersistError =
			args.onPersistError ??
			((err) => {
				console.warn('[SurrealDBChatModel] persist failed:', err);
			});

		const { client, owned } = resolveClient(args.surreal);
		this.client = client;
		this.ownsClient = owned;

		// Mirror the delegate's own settings, so the wrapper does not quietly
		// report different behaviour to the layers that read them.
		this.disableStreaming = args.delegate.disableStreaming;
		if ((args.inheritCache ?? true) && args.delegate.cache) {
			this.cache = args.delegate.cache;
		}
	}

	/**
	 * The delegate's type, verbatim.
	 *
	 * Deliberately not `surrealdb:${...}`: this string feeds LangSmith's
	 * provider detection and the LLM cache key, and prefixing it breaks both.
	 * The wrapper identifies itself through `getName()` instead.
	 *
	 * The optional chain is load-bearing: `BaseChatModel` initialises
	 * `lc_namespace = ['langchain', 'chat_models', this._llmType()]` as an
	 * instance field, which runs during `super()` — before `this.delegate`
	 * has been assigned. We override `lc_namespace` anyway, so the value the
	 * base computes is discarded; it just must not throw.
	 */
	override _llmType(): string {
		return this.delegate?._llmType() ?? 'surrealdb';
	}

	override getName(): string {
		return 'SurrealDBChatModel';
	}

	// --- forwarded to the delegate ------------------------------------
	// Left unforwarded, these report the wrapper's defaults to tracing,
	// token counting and caching rather than the model actually running.

	override _modelType(): string {
		return this.delegate?._modelType() ?? 'base_chat_model';
	}

	override invocationParams(options?: this['ParsedCallOptions']) {
		return this.delegate.invocationParams(
			options as never,
		) as ReturnType<this['invocationParams']>;
	}

	override getLsParams(options: this['ParsedCallOptions']) {
		return this.delegate.getLsParams(options as never);
	}

	override _combineLLMOutput(
		...llmOutputs: LLMResult['llmOutput'][]
	): LLMResult['llmOutput'] {
		return this.delegate._combineLLMOutput?.(...llmOutputs);
	}

	override async getNumTokens(
		content: Parameters<BaseLangChainChatModel['getNumTokens']>[0],
	) {
		return this.delegate.getNumTokens(content);
	}

	override get callKeys(): string[] {
		return this.delegate?.callKeys ?? super.callKeys;
	}

	/**
	 * Bind tools by asking the delegate to convert them — only it knows its
	 * provider's tool schema — then lifting the resulting call options onto
	 * ourselves, so generation still flows through this wrapper and is still
	 * persisted.
	 *
	 * Without this, the inherited `withStructuredOutput` throws.
	 */
	override bindTools(
		tools: BindToolsInput[],
		kwargs?: Partial<BaseChatModelCallOptions>,
	) {
		if (typeof this.delegate.bindTools !== 'function') {
			throw new Error(
				`SurrealDBChatModel: the delegate (${this.delegate._llmType()}) ` +
					`does not implement bindTools, so tools cannot be bound.`,
			);
		}
		const bound = this.delegate.bindTools(tools, kwargs as never);
		const lifted =
			bound instanceof RunnableBinding
				? ((bound.kwargs ?? {}) as Partial<BaseChatModelCallOptions>)
				: ({ tools, ...kwargs } as Partial<BaseChatModelCallOptions>);
		return this.withConfig(lifted);
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
				{ name: 'messages', type: 'TYPE string' },
				{ name: 'result', type: 'TYPE string' },
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
		let accumulated: AIMessageChunk | undefined;
		const stream = this.delegate._streamResponseChunks(
			messages,
			options as BaseChatModelCallOptions,
			runManager,
		);
		try {
			for await (const chunk of stream) {
				// Merge rather than collect: the persisted message must be the
				// whole completion, not its first chunk.
				const message = chunk.message as AIMessageChunk;
				accumulated = accumulated ? accumulated.concat(message) : message;
				yield chunk;
			}
		} finally {
			// `finally`, so a consumer that breaks early — which invokes this
			// generator's `return()` and skips everything after the loop —
			// still persists what was streamed.
			const message = accumulated ?? new AIMessageChunk('');
			await this.persist(messages, {
				generations: [
					{ text: message.text ?? '', message } as ChatGeneration,
				],
			});
		}
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
		try {
			await this.client.execute(
				`CREATE ${this.tableName} CONTENT $row`,
				{
					row: compactRow({
						thread_id: this.threadId,
						llm_type: this.delegate._llmType(),
						messages: JSON.stringify(
							mapChatMessagesToStoredMessages(messages),
						),
						result: JSON.stringify(serialiseResult(result)),
					}),
				},
			);
		} catch (err) {
			// A database hiccup must not turn a completed LLM call into a
			// thrown one — least of all in the streaming path, where the
			// consumer already has every chunk.
			if (this.strictPersistence) throw err;
			this.onPersistError(err);
		}
	}
}

function serialiseResult(result: ChatResult): Record<string, unknown> {
	return {
		generations: result.generations.map((g) => ({
			text: g.text,
			message: g.message
				? mapChatMessagesToStoredMessages([g.message])[0]
				: null,
		})),
		llmOutput: result.llmOutput ?? null,
	};
}
