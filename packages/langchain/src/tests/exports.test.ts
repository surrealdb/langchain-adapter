import { describe, expect, it } from 'vitest';
import * as caches from '../caches/index.js';
import * as callbacks from '../callbacks/index.js';
import * as chatHistory from '../chat_history/index.js';
import * as chatModels from '../chat_models/index.js';
import * as indexes from '../indexes/index.js';
import * as barrel from '../index.js';
import * as retrievers from '../retrievers/index.js';
import * as tools from '../tools/index.js';
import * as vectorstores from '../vectorstores/index.js';

const SUBPATHS = {
	vectorstores: [vectorstores, ['SurrealDBVectorStore']],
	retrievers: [retrievers, ['HybridRetriever', 'AgentMemoryRetriever']],
	tools: [
		tools,
		[
			'createQueryTool',
			'createRecordTool',
			'createTool',
			'createAgentMemoryQueryTool',
			'createAgentMemoryReflectTool',
		],
	],
	chat_models: [chatModels, ['SurrealDBChatModel']],
	indexes: [indexes, ['SurrealDBRecordManager']],
	caches: [caches, ['SurrealDBLLMCache']],
	chat_history: [chatHistory, ['SurrealDBChatMessageHistory']],
	callbacks: [callbacks, ['SurrealDBChatCallbackHandler']],
} as const;

describe('@surrealdb/langchain exports', () => {
	for (const [subpath, [mod, names]] of Object.entries(SUBPATHS)) {
		it.each(names as readonly string[])(
			`${subpath} exports %s, and the barrel re-exports it`,
			(name) => {
				const m = mod as Record<string, unknown>;
				expect(typeof m[name]).toBe('function');
				expect(
					typeof (barrel as Record<string, unknown>)[name],
				).toBe('function');
			},
		);
	}

	it.each([
		'SpectronRetriever',
		'SpectronQueryTool',
		'SpectronReflectTool',
		'AgentMemoryQueryTool',
		'AgentMemoryReflectTool',
		'QueryTool',
		'RecordTool',
		'VectorStore',
		'ChatModel',
	])('no longer exports the retired name %s', (name) => {
		expect((barrel as Record<string, unknown>)[name]).toBeUndefined();
	});
});
