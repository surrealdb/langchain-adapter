import { SurrealDBClient } from '@surrealdb/langchain-core';
import { describe, expect, it } from 'vitest';
import { QueryTool } from '../tools/surql.js';

function makeTool(opts: { readOnly?: boolean } = {}) {
	const client = new SurrealDBClient({
		url: 'ws://localhost:8000',
		username: 'root',
		password: 'root',
	});
	return new QueryTool({ surreal: client, ...opts });
}

describe('QueryTool read-only gate', () => {
	it('rejects non-SELECT/INFO statements when readOnly is true', async () => {
		const tool = makeTool();
		await expect(
			tool.invoke({ surql: 'CREATE user CONTENT { name: "x" }' }),
		).rejects.toThrow(/read-only/);
		await expect(
			tool.invoke({ surql: 'DELETE FROM user' }),
		).rejects.toThrow(/read-only/);
		await expect(
			tool.invoke({ surql: 'UPDATE user SET name = "x"' }),
		).rejects.toThrow(/read-only/);
		await expect(
			tool.invoke({
				surql: 'DEFINE TABLE user SCHEMAFULL',
			}),
		).rejects.toThrow(/read-only/);
	});

	it('rejects SELECT statements containing forbidden keywords', async () => {
		const tool = makeTool();
		// Conjunction or comment tricks – a sneaky CREATE inside a SELECT.
		await expect(
			tool.invoke({
				surql: 'SELECT * FROM (CREATE foo SET x = 1)',
			}),
		).rejects.toThrow(/read-only/);
	});

	it('exposes the structured zod schema', () => {
		const tool = makeTool();
		const parsed = tool.schema.parse({
			surql: 'SELECT 1',
			vars: { x: 2 },
		});
		expect(parsed).toEqual({ surql: 'SELECT 1', vars: { x: 2 } });
	});
});
