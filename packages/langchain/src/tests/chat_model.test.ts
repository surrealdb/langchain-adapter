import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SurrealDBChatModel } from '../chat_models/surrealdb.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make(
	delegate = new FakeListChatModel({ responses: ['hello world'] }),
	args: Record<string, unknown> = {},
) {
	const client = new FakeSurrealDBClient();
	const model = new SurrealDBChatModel({
		surreal: client,
		delegate,
		skipInitSchema: true,
		skipVersionCheck: true,
		...args,
	});
	return { client, model, delegate };
}

describe('SurrealDBChatModel identity', () => {
	it('reports the delegate’s llm type verbatim', () => {
		// Prefixing it would break LangSmith provider detection and the cache key.
		const { model, delegate } = make();
		expect(model._llmType()).toBe(delegate._llmType());
		expect(model._llmType()).not.toContain('surrealdb:');
	});

	it('identifies the wrapper through getName instead', () => {
		expect(make().model.getName()).toBe('SurrealDBChatModel');
	});

	it('forwards the model type and token counting', async () => {
		const { model, delegate } = make();
		expect(model._modelType()).toBe(delegate._modelType());
		expect(await model.getNumTokens('abc')).toBe(
			await delegate.getNumTokens('abc'),
		);
	});
});

describe('SurrealDBChatModel tool binding', () => {
	const tool = {
		name: 'get_weather',
		description: 'Get weather',
		schema: z.object({ city: z.string() }),
	};

	it('implements bindTools, so withStructuredOutput no longer throws', () => {
		const { model } = make();
		expect(typeof model.bindTools).toBe('function');
		expect(() =>
			model.withStructuredOutput(z.object({ answer: z.string() })),
		).not.toThrow();
	});

	it('returns a runnable that still routes through the wrapper', () => {
		const { model } = make();
		const bound = model.bindTools([tool]);
		expect(bound).toBeDefined();
		expect(typeof bound.invoke).toBe('function');
	});

	it('explains itself when the delegate cannot bind tools', () => {
		const delegate = new FakeListChatModel({ responses: ['x'] });
		// biome-ignore lint/performance/noDelete: emulating a model without tool support
		delete (delegate as { bindTools?: unknown }).bindTools;
		Object.defineProperty(delegate, 'bindTools', { value: undefined });
		const { model } = make(delegate);
		expect(() => model.bindTools([tool])).toThrow(
			/does not implement bindTools/,
		);
	});
});

describe('SurrealDBChatModel streaming persistence', () => {
	/** A delegate that streams the given chunks. */
	class StreamingDelegate extends FakeListChatModel {
		constructor(private readonly chunks: string[]) {
			super({ responses: [chunks.join('')] });
		}
		override async *_streamResponseChunks() {
			for (const text of this.chunks) {
				yield new ChatGenerationChunk({
					text,
					message: new AIMessageChunk(text),
				});
			}
		}
	}

	async function drain(model: SurrealDBChatModel, stopAfter?: number) {
		let i = 0;
		for await (const _ of await model.stream([new HumanMessage('hi')])) {
			if (stopAfter !== undefined && ++i >= stopAfter) break;
		}
	}

	it('persists the whole completion, not the first chunk', async () => {
		const { client, model } = make(
			new StreamingDelegate(['Hel', 'lo', ' world']),
		);
		await drain(model);
		const row = client.last().bindings?.row as { result: string };
		const result = JSON.parse(row.result);
		expect(result.generations[0].text).toBe('Hello world');
		expect(result.generations[0].message.data.content).toBe('Hello world');
	});

	it('persists what was streamed when the consumer breaks early', async () => {
		// Driven directly rather than through `.stream()`, which reads ahead
		// and would consume the generator fully before a break propagates.
		const { client, model } = make(
			new StreamingDelegate(['Hel', 'lo', ' world']),
		);
		const gen = model._streamResponseChunks(
			[new HumanMessage('hi')],
			{} as never,
		);
		await gen.next();
		await gen.next();
		await gen.return(undefined as never); // triggers the `finally`

		const row = client.last().bindings?.row as { result: string };
		expect(JSON.parse(row.result).generations[0].text).toBe('Hello');
	});

	it('does not fail the call when the write fails', async () => {
		const onPersistError = vi.fn();
		const { client, model } = make(new StreamingDelegate(['a', 'b']), {
			onPersistError,
		});
		client.execute = () => Promise.reject(new Error('db down'));
		await expect(drain(model)).resolves.toBeUndefined();
		expect(onPersistError).toHaveBeenCalledOnce();
	});

	it('can be made strict when a lost write should be fatal', async () => {
		const { client, model } = make(new StreamingDelegate(['a']), {
			strictPersistence: true,
		});
		client.execute = () => Promise.reject(new Error('db down'));
		await expect(drain(model)).rejects.toThrow('db down');
	});
});

describe('SurrealDBChatModel non-streaming persistence', () => {
	it('stores messages as v1 stored-message JSON', async () => {
		const { client, model } = make();
		await model.invoke([new HumanMessage('hi')]);
		const row = client.last().bindings?.row as { messages: string };
		const stored = JSON.parse(row.messages);
		expect(stored[0]).toMatchObject({ type: 'human' });
		expect(stored[0].data.content).toBe('hi');
	});

	it('preserves tool calls through the stored form', async () => {
		const message = new AIMessage({
			content: '',
			tool_calls: [{ name: 'get_weather', args: { city: 'x' }, id: 't1' }],
		});
		const { client, model } = make();
		await model.invoke([message]);
		const stored = JSON.parse(
			(client.last().bindings?.row as { messages: string }).messages,
		);
		expect(stored[0].data.tool_calls[0]).toMatchObject({ id: 't1' });
	});
});
