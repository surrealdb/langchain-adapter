import { describe, expect, it } from 'vitest';
import {
	assertCount,
	assertIdent,
	defineTable,
	defineVectorIndex,
} from '../schema.js';

describe('assertIdent', () => {
	it('accepts snake_case identifiers', () => {
		expect(assertIdent('users_v2')).toBe('users_v2');
	});

	it('rejects identifiers with whitespace or punctuation', () => {
		expect(() => assertIdent('user table')).toThrow();
		expect(() => assertIdent('user;DROP')).toThrow();
		expect(() => assertIdent('1bad')).toThrow();
	});
});

describe('defineTable', () => {
	it('emits SCHEMAFULL DEFINE TABLE plus per-field DDL', () => {
		const ddl = defineTable('users', [
			{ name: 'name', type: 'TYPE string' },
			{ name: 'age', type: 'TYPE int DEFAULT 0' },
		]);
		expect(ddl).toContain('DEFINE TABLE IF NOT EXISTS users SCHEMAFULL');
		expect(ddl).toContain(
			'DEFINE FIELD IF NOT EXISTS name ON users TYPE string',
		);
		expect(ddl).toContain(
			'DEFINE FIELD IF NOT EXISTS age ON users TYPE int DEFAULT 0',
		);
	});
});

describe('defineVectorIndex', () => {
	it('emits HNSW DDL with cosine and overrideable params', () => {
		const ddl = defineVectorIndex({
			tableName: 'docs',
			indexName: 'docs_emb_idx',
			field: 'emb',
			dimensions: 1536,
			distance: 'cosine',
			type: 'hnsw',
			hnsw: { m: 24, efc: 200 },
		});
		expect(ddl).toContain('HNSW DIMENSION 1536');
		expect(ddl).toContain('DIST COSINE');
		expect(ddl).toContain('M 24');
		expect(ddl).toContain('EFC 200');
	});

	it('builds a DISKANN index', () => {
		const ddl = defineVectorIndex({
			tableName: 'docs',
			indexName: 'idx',
			field: 'emb',
			dimensions: 64,
			distance: 'euclidean',
			type: 'diskann',
		});
		expect(ddl).toContain('DISKANN DIMENSION 64');
		expect(ddl).toContain('DIST EUCLIDEAN');
	});

	it('never emits MTREE, which SurrealDB v3 removed', () => {
		// `DEFINE INDEX … MTREE` is a parse error on 3.2, so the option is
		// gone rather than silently producing invalid DDL.
		for (const type of ['hnsw', 'diskann', 'none'] as const) {
			expect(
				defineVectorIndex({
					tableName: 'docs',
					indexName: 'idx',
					field: 'emb',
					dimensions: 8,
					distance: 'cosine',
					type,
				}),
			).not.toContain('MTREE');
		}
	});

	it('returns empty string when type is none', () => {
		expect(
			defineVectorIndex({
				tableName: 'docs',
				indexName: 'idx',
				field: 'emb',
				dimensions: 8,
				distance: 'cosine',
				type: 'none',
			}),
		).toBe('');
	});
});

describe('assertCount', () => {
	it('accepts non-negative safe integers', () => {
		expect(assertCount(0)).toBe(0);
		expect(assertCount(10)).toBe(10);
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
		'rejects %p',
		(bad) => {
			expect(() => assertCount(bad)).toThrow(/Invalid SurrealDB limit/);
		},
	);

	it('names the role in the message', () => {
		expect(() => assertCount(-1, 'offset')).toThrow(
			/Invalid SurrealDB offset/,
		);
	});
});
