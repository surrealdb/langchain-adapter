import { AgentMemory, type AgentMemoryOptions } from '@surrealdb/memory';

/**
 * Config accepted by the Agent Memory-backed adapters: either a
 * pre-constructed {@link AgentMemory} client, or the options to build one.
 * Every field is optional so it can fall back to the
 * `AGENT_MEMORY_ENDPOINT` / `AGENT_MEMORY_API_KEY` / `AGENT_MEMORY_CONTEXT`
 * environment variables.
 */
export type AgentMemoryClientConfig =
	| AgentMemory
	| Partial<AgentMemoryOptions>;

/**
 * Resolves an {@link AgentMemory} client from adapter config.
 *
 * A pre-constructed client is returned as-is. Otherwise `endpoint`, `apiKey`,
 * and `context` are taken from the config, falling back to the
 * `AGENT_MEMORY_ENDPOINT`, `AGENT_MEMORY_API_KEY`, and
 * `AGENT_MEMORY_CONTEXT` environment variables. Each is required — a missing
 * one throws a clear error.
 */
export function resolveAgentMemory(
	client: AgentMemoryClientConfig,
): AgentMemory {
	if (client instanceof AgentMemory) return client;

	const endpoint = client.endpoint ?? process.env.AGENT_MEMORY_ENDPOINT;
	const apiKey = client.apiKey ?? process.env.AGENT_MEMORY_API_KEY;
	const context = client.context ?? process.env.AGENT_MEMORY_CONTEXT;

	if (!endpoint) {
		throw new Error(
			'Agent Memory: missing `endpoint`. Pass it explicitly or set AGENT_MEMORY_ENDPOINT.',
		);
	}
	if (!apiKey) {
		throw new Error(
			'Agent Memory: missing `apiKey`. Pass it explicitly or set AGENT_MEMORY_API_KEY.',
		);
	}
	if (!context) {
		throw new Error(
			'Agent Memory: missing `context`. Pass it explicitly or set AGENT_MEMORY_CONTEXT.',
		);
	}

	return new AgentMemory({ ...client, endpoint, apiKey, context });
}
