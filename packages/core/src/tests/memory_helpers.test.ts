import { AgentMemory } from '@surrealdb/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentMemory } from '../memory_helpers.js';

const VARS = [
	'AGENT_MEMORY_ENDPOINT',
	'AGENT_MEMORY_API_KEY',
	'AGENT_MEMORY_CONTEXT',
	'SPECTRON_ENDPOINT',
	'SPECTRON_API_KEY',
	'SPECTRON_CONTEXT',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
	for (const v of VARS) delete process.env[v];
});

afterEach(() => {
	for (const v of VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

describe('resolveAgentMemory', () => {
	it('reads all three AGENT_MEMORY_* vars from the environment', () => {
		process.env.AGENT_MEMORY_ENDPOINT = 'https://api.example.test';
		process.env.AGENT_MEMORY_API_KEY = 'sk-test';
		process.env.AGENT_MEMORY_CONTEXT = 'ctx';
		const client = resolveAgentMemory({});
		expect(client).toBeInstanceOf(AgentMemory);
		expect(client.contextId).toBe('ctx');
	});

	it('passes a pre-constructed client through by identity', () => {
		const existing = new AgentMemory({
			endpoint: 'https://api.example.test',
			apiKey: 'sk-test',
			context: 'ctx',
		});
		expect(resolveAgentMemory(existing)).toBe(existing);
	});

	it('lets explicit options win over the environment', () => {
		process.env.AGENT_MEMORY_ENDPOINT = 'https://env.example.test';
		process.env.AGENT_MEMORY_API_KEY = 'sk-env';
		process.env.AGENT_MEMORY_CONTEXT = 'env-ctx';
		expect(resolveAgentMemory({ context: 'explicit' }).contextId).toBe(
			'explicit',
		);
	});

	it.each([
		['endpoint', 'AGENT_MEMORY_ENDPOINT'],
		['apiKey', 'AGENT_MEMORY_API_KEY'],
		['context', 'AGENT_MEMORY_CONTEXT'],
	])('names %s and its env var when missing', (field, envVar) => {
		const env: Record<string, string> = {
			AGENT_MEMORY_ENDPOINT: 'https://api.example.test',
			AGENT_MEMORY_API_KEY: 'sk-test',
			AGENT_MEMORY_CONTEXT: 'ctx',
		};
		delete env[envVar];
		Object.assign(process.env, env);
		expect(() => resolveAgentMemory({})).toThrow(
			new RegExp(`${field}.*${envVar}`, 's'),
		);
	});

	it('does NOT fall back to the retired SPECTRON_* variables', () => {
		// 0.2.0 is a clean break: the old names must not keep working.
		process.env.SPECTRON_ENDPOINT = 'https://api.example.test';
		process.env.SPECTRON_API_KEY = 'sk-test';
		process.env.SPECTRON_CONTEXT = 'ctx';
		expect(() => resolveAgentMemory({})).toThrow(/AGENT_MEMORY_ENDPOINT/);
	});
});
