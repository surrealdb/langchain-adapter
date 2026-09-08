import { RecordId } from 'surrealdb';
import { describe, expect, it } from 'vitest';
import {
	escapeIdent,
	isRoundTrippableId,
	recordIdToString,
	toRecordId,
} from '../record.js';

describe('toRecordId', () => {
	it('builds a RecordId rather than a "table:id" string', () => {
		const rid = toRecordId('documents', 'abc');
		expect(rid).toBeInstanceOf(RecordId);
		expect(rid.id).toBe('abc');
		expect(String(rid.table)).toBe('documents');
	});

	it('leaves the id part unescaped — the driver encodes it', () => {
		// The bug this guards: hand-building `table:${escape(id)}` and passing
		// it as a string put the *whole string* in the id part.
		const rid = toRecordId('documents', 'has space');
		expect(rid.id).toBe('has space');
		expect(rid.toString()).not.toContain('documents:documents');
	});
});

describe('escapeIdent', () => {
	it('uses SurrealDB angle brackets, never U+29FC/U+29FD', () => {
		const escaped = escapeIdent('has space');
		expect(escaped).toBe('⟨has space⟩');
		expect(escaped).not.toContain('⧼');
		expect(escaped).not.toContain('⧽');
	});

	it('passes plain identifiers through untouched', () => {
		expect(escapeIdent('plain_id1')).toBe('plain_id1');
	});
});

describe('recordIdToString', () => {
	it.each([
		['plain', 'plain'],
		['has space', 'has space'],
		['has:colon', 'has:colon'],
		['dash-ed-uuid-0000', 'dash-ed-uuid-0000'],
		['', ''],
		['1234', '1234'],
		['ünïcødé', 'ünïcødé'],
	])('round-trips %j through a RecordId', (id, expected) => {
		expect(recordIdToString(toRecordId('documents', id))).toBe(expected);
	});

	it('returns the id part, not the qualified table:id', () => {
		expect(recordIdToString(toRecordId('documents', 'abc'))).toBe('abc');
	});

	it('falls back to the qualified form for non-string id parts', () => {
		// No lossless string form exists that toRecordId could rebuild.
		const rid = toRecordId('documents', ['a', 'b']);
		const s = recordIdToString(rid);
		expect(s).toContain('documents:');
		expect(isRoundTrippableId(s)).toBe(false);
	});

	it('handles null and plain strings', () => {
		expect(recordIdToString(null)).toBe('');
		expect(recordIdToString(undefined)).toBe('');
		expect(recordIdToString('already-a-string')).toBe('already-a-string');
	});
});
