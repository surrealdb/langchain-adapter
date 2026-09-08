import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { SurrealDBChatMessageHistory } from '../chat_history/surrealdb.js';
import { FakeSurrealDBClient } from './fake_client.js';

function make(sessionId = 's1') {
	const client = new FakeSurrealDBClient();
	const history = new SurrealDBChatMessageHistory({
		surreal: client,
		sessionId,
		skipInitSchema: true,
		skipVersionCheck: true,
	});
	return { client, history };
}

/** Capture the rows a set of messages would be written as. */
async function rowsFor(messages: Parameters<
	SurrealDBChatMessageHistory['addMessages']
>[0], maxSeq: number | null = null) {
	const { client, history } = make();
	client.rows = [[{ next: maxSeq ?? -1 }]];
	await history.addMessages(messages);
	const write = client.last();
	return write.bindings?.rows as Record<string, unknown>[];
}

describe('SurrealDBChatMessageHistory.addMessages', () => {
	it('numbers messages from 0 in an empty session', async () => {
		const rows = await rowsFor([
			new HumanMessage('hi'),
			new AIMessage('hello'),
		]);
		expect(rows.map((r) => r.seq)).toEqual([0, 1]);
		expect(rows.map((r) => r.type)).toEqual(['human', 'ai']);
	});

	it('continues from the highest existing seq', async () => {
		const rows = await rowsFor([new HumanMessage('hi')], 4);
		expect(rows[0]?.seq).toBe(5);
	});

	it('reads the max seq and writes inside one transaction', async () => {
		const { client, history } = make();
		client.rows = [[{ next: -1 }]];
		await history.addMessages([new HumanMessage('hi')]);
		// Both statements must be in the same tx or two appenders collide.
		expect(client.queries[0]?.surql).toContain('math::max(seq)');
		expect(client.queries[1]?.surql).toContain('INSERT INTO');
	});

	it('denormalises the text for full-text indexing', async () => {
		const rows = await rowsFor([new HumanMessage('searchable text')]);
		expect(rows[0]?.text).toBe('searchable text');
	});

	it('does nothing for an empty list', async () => {
		const { client, history } = make();
		await history.addMessages([]);
		expect(client.queries).toHaveLength(0);
	});
});

describe('SurrealDBChatMessageHistory round-trip', () => {
	it('preserves tool calls on an AI message', async () => {
		const message = new AIMessage({
			content: 'calling',
			tool_calls: [{ name: 'search', args: { q: 'x' }, id: 't1' }],
		});
		const rows = await rowsFor([message]);

		const { client, history } = make();
		client.rows = [[{ type: rows[0]?.type, data: rows[0]?.data, seq: 0 }]];
		const [back] = await history.getMessages();
		expect((back as AIMessage).tool_calls?.[0]).toMatchObject({
			name: 'search',
			id: 't1',
		});
	});

	it('preserves array content blocks', async () => {
		const message = new HumanMessage({
			content: [
				{ type: 'text', text: 'describe this' },
				{ type: 'image_url', image_url: { url: 'https://x/y.png' } },
			],
		});
		const rows = await rowsFor([message]);

		const { client, history } = make();
		client.rows = [[{ type: rows[0]?.type, data: rows[0]?.data, seq: 0 }]];
		const [back] = await history.getMessages();
		expect(Array.isArray(back?.content)).toBe(true);
		expect(back?.content).toHaveLength(2);
	});

	it('preserves response metadata and ids', async () => {
		const message = new AIMessage({
			content: 'x',
			id: 'msg-1',
			response_metadata: { model: 'gpt-4.1-mini' },
		});
		const rows = await rowsFor([message]);

		const { client, history } = make();
		client.rows = [[{ type: rows[0]?.type, data: rows[0]?.data, seq: 0 }]];
		const [back] = await history.getMessages();
		expect(back?.id).toBe('msg-1');
		expect(back?.response_metadata).toMatchObject({
			model: 'gpt-4.1-mini',
		});
	});

	it('reads back in seq order and scoped to the session', async () => {
		const { client, history } = make('s7');
		client.rows = [[]];
		await history.getMessages();
		const { surql, bindings } = client.only();
		expect(surql).toContain('WHERE session_id = $sid ORDER BY seq ASC');
		expect(bindings?.sid).toBe('s7');
	});

	it('handles system messages', async () => {
		const rows = await rowsFor([new SystemMessage('be brief')]);
		expect(rows[0]?.type).toBe('system');
	});
});

describe('SurrealDBChatMessageHistory.clear', () => {
	it('deletes only this session', async () => {
		const { client, history } = make('s9');
		await history.clear();
		const { surql, bindings } = client.only();
		expect(surql).toContain('WHERE session_id = $sid');
		expect(bindings?.sid).toBe('s9');
	});
});
