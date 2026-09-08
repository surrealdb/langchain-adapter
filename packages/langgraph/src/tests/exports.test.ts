import { describe, expect, it } from 'vitest';
import { SurrealDBNodeCache } from '../cache.js';
import { SurrealDBSaver } from '../checkpoint.js';
import * as barrel from '../index.js';
import { AgentMemoryStore } from '../memory_store.js';
import { SurrealDBStore } from '../store.js';

// Every name below is public API. This suite is the cheapest guard against a
// half-finished rename or a tsup entry that was never added: both show up as a
// missing export rather than a type error.
describe('@surrealdb/langgraph exports', () => {
	it.each([
		['SurrealDBSaver', SurrealDBSaver],
		['SurrealDBStore', SurrealDBStore],
		['AgentMemoryStore', AgentMemoryStore],
		['SurrealDBNodeCache', SurrealDBNodeCache],
	])('%s is a class, from its own module', (_name, cls) => {
		expect(typeof cls).toBe('function');
	});

	it.each([
		'SurrealDBSaver',
		'SurrealDBStore',
		'AgentMemoryStore',
		'SurrealDBNodeCache',
	])(
		're-exports %s from the barrel',
		(name) => {
			expect(typeof (barrel as Record<string, unknown>)[name]).toBe(
				'function',
			);
		},
	);

	it('re-exports the Agent Memory client surface from core', () => {
		expect(typeof barrel.AgentMemory).toBe('function');
		expect(typeof barrel.AgentMemoryError).toBe('function');
		expect(typeof barrel.resolveAgentMemory).toBe('function');
	});

	it.each([
		'Spectron',
		'SpectronStore',
		'SpectronError',
		'resolveSpectron',
		'CheckpointSaver',
		'Store',
	])('no longer exports the retired name %s', (name) => {
		expect((barrel as Record<string, unknown>)[name]).toBeUndefined();
	});
});
