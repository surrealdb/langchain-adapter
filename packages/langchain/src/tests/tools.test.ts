import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
	createQueryTool,
	createRecordTool,
	createTool,
	type SurrealQLToolArtifact,
} from '../tools/surql.js';
import { FakeSurrealDBClient } from './fake_client.js';
import { z } from 'zod';

function makeTool(opts: { readOnly?: boolean; maxRows?: number } = {}) {
	const client = new FakeSurrealDBClient();
	// `db.query` is what the tools call; stub it on the fake's Surreal handle.
	const calls: { surql: string; vars?: unknown }[] = [];
	let responses: unknown[] = [[]];
	(client.db as unknown as { query: unknown }).query = async (
		surql: string,
		vars?: unknown,
	) => {
		calls.push({ surql, vars });
		return responses;
	};
	const tool = createQueryTool({ surreal: client, ...opts });
	return {
		tool,
		calls,
		setRows: (rows: unknown[]) => {
			responses = [rows];
		},
	};
}

describe('SurrealQL query tool read-only gate', () => {
	it.each([
		['CREATE user CONTENT { name: "x" }'],
		['DELETE FROM user'],
		['UPDATE user SET name = "x"'],
		['DEFINE TABLE user SCHEMAFULL'],
		['REMOVE TABLE user'],
		['ALTER TABLE user'],
		['KILL "abc"'],
		['LET $x = 1'],
	])('rejects %s', async (surql) => {
		const { tool } = makeTool();
		await expect(tool.invoke({ surql })).rejects.toThrow(/read-only/);
	});

	it('rejects a write smuggled inside a SELECT subquery', async () => {
		const { tool } = makeTool();
		await expect(
			tool.invoke({ surql: 'SELECT * FROM (CREATE foo SET x = 1)' }),
		).rejects.toThrow(/read-only/);
	});

	it('rejects a second statement riding behind a valid SELECT', async () => {
		const { tool } = makeTool();
		await expect(
			tool.invoke({ surql: 'SELECT * FROM user; REMOVE TABLE user' }),
		).rejects.toThrow(/single statement/);
	});

	it('rejects a custom fn:: call, whose body is not visible here', async () => {
		const { tool } = makeTool();
		await expect(
			tool.invoke({ surql: 'SELECT * FROM fn::anything()' }),
		).rejects.toThrow(/read-only/);
	});

	it('rejects LIVE, which opens a subscription rather than reading', async () => {
		const { tool } = makeTool();
		await expect(
			tool.invoke({ surql: 'LIVE SELECT * FROM user' }),
		).rejects.toThrow(/read-only/);
	});

	it('allows a plain SELECT', async () => {
		const { tool, setRows } = makeTool();
		setRows([{ id: 1 }]);
		await expect(tool.invoke({ surql: 'SELECT * FROM user' })).resolves
			.toBeDefined();
	});

	it('allows anything when readOnly is off', async () => {
		const { tool, setRows } = makeTool({ readOnly: false });
		setRows([]);
		await expect(
			tool.invoke({ surql: 'CREATE user CONTENT {}' }),
		).resolves.toBeDefined();
	});
});

describe('SurrealQL tools return content and artifact', () => {
	it('gives the model a digest and the caller the rows', async () => {
		const { tool, setRows } = makeTool();
		setRows([{ id: 1 }, { id: 2 }]);
		const msg = (await tool.invoke({
			type: 'tool_call',
			id: '1',
			name: tool.name,
			args: { surql: 'SELECT * FROM user' },
		})) as ToolMessage;

		expect(msg).toBeInstanceOf(ToolMessage);
		expect(msg.content).toContain('2 row(s)');
		const artifact = msg.artifact as SurrealQLToolArtifact;
		expect(artifact.rows).toEqual([{ id: 1 }, { id: 2 }]);
		expect(artifact.truncated).toBe(false);
	});

	it('reports truncation rather than silently dropping rows', async () => {
		const { tool, setRows } = makeTool({ maxRows: 1 });
		setRows([{ id: 1 }, { id: 2 }, { id: 3 }]);
		const msg = (await tool.invoke({
			type: 'tool_call',
			id: '1',
			name: tool.name,
			args: { surql: 'SELECT * FROM user' },
		})) as ToolMessage;
		const artifact = msg.artifact as SurrealQLToolArtifact;
		expect(artifact.rows).toHaveLength(1);
		expect(artifact.rowCount).toBe(3);
		expect(artifact.truncated).toBe(true);
		expect(msg.content).toContain('showing 1 of 3');
	});

	it('exposes the structured zod schema', () => {
		const { tool } = makeTool();
		expect(
			tool.schema.parse({ surql: 'SELECT 1', vars: { x: 2 } }),
		).toEqual({ surql: 'SELECT 1', vars: { x: 2 } });
	});
});

describe('createRecordTool', () => {
	it('runs its own template, never the agent’s SurrealQL', async () => {
		const client = new FakeSurrealDBClient();
		const calls: string[] = [];
		(client.db as unknown as { query: unknown }).query = async (
			surql: string,
		) => {
			calls.push(surql);
			return [[{ ok: true }]];
		};
		const tool = createRecordTool({
			surreal: client,
			name: 'find_user',
			description: 'Find a user by name',
			schema: z.object({ name: z.string() }),
			surql: 'SELECT * FROM user WHERE name = $name',
		});
		await tool.invoke({ name: 'ada' });
		expect(calls).toEqual(['SELECT * FROM user WHERE name = $name']);
	});
});

describe('createTool', () => {
	it('builds one tool identity, not a new class per call', async () => {
		// The old implementation declared a class inside the factory, so every
		// call produced a distinct constructor and defeated `instanceof`.
		const client = new FakeSurrealDBClient();
		const args = {
			surreal: client,
			name: 'echo',
			description: 'echo',
			schema: z.object({ v: z.string() }),
			handler: async (_c: unknown, input: { v: string }) => input.v,
		};
		const a = createTool(args);
		const b = createTool(args);
		expect(a.constructor).toBe(b.constructor);
		expect(await a.invoke({ v: 'hi' })).toBe('hi');
	});
});
