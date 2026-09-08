import { describe, expect, it } from 'vitest';
import { translateFilter } from '../filter.js';

describe('translateFilter', () => {
	it('returns empty expr for empty/undefined input', () => {
		expect(translateFilter(undefined)).toEqual({ expr: '', bindings: {} });
		expect(translateFilter({})).toEqual({ expr: '', bindings: {} });
	});

	it('translates a bare value as equality', () => {
		const r = translateFilter({ source: 'docs' });
		expect(r.expr).toBe('source = $f0');
		expect(r.bindings).toEqual({ f0: 'docs' });
	});

	it('honours fieldPrefix', () => {
		const r = translateFilter(
			{ source: 'docs' },
			{ fieldPrefix: 'metadata' },
		);
		expect(r.expr).toBe('metadata.source = $f0');
	});

	it('AND-joins multiple top-level keys', () => {
		const r = translateFilter({ a: 1, b: 2 });
		expect(r.expr).toBe('a = $f0 AND b = $f1');
		expect(r.bindings).toEqual({ f0: 1, f1: 2 });
	});

	it('handles comparison operators', () => {
		const r = translateFilter({ score: { $gte: 0.8, $lt: 1.0 } });
		expect(r.expr).toBe('(score >= $f0 AND score < $f1)');
		expect(r.bindings).toEqual({ f0: 0.8, f1: 1.0 });
	});

	it('handles $in / $nin', () => {
		const r = translateFilter({ tag: { $in: ['a', 'b'] } });
		expect(r.expr).toBe('tag INSIDE $f0');
		expect(r.bindings).toEqual({ f0: ['a', 'b'] });
	});

	it('handles $exists', () => {
		expect(translateFilter({ x: { $exists: true } }).expr).toBe(
			'x IS NOT NONE',
		);
		expect(translateFilter({ x: { $exists: false } }).expr).toBe(
			'x IS NONE',
		);
	});

	it('treats null as IS NONE', () => {
		expect(translateFilter({ x: null }).expr).toBe('x IS NONE');
	});

	it('throws on unsupported operator', () => {
		expect(() => translateFilter({ x: { $regex: 'foo' } })).toThrow(
			/Unsupported filter operator/,
		);
	});

	it('uses custom bind prefix', () => {
		const r = translateFilter({ x: 1 }, { bindPrefix: 'meta' });
		expect(r.expr).toBe('x = $meta0');
		expect(r.bindings).toEqual({ meta0: 1 });
	});
});

describe('translateFilter field escaping', () => {
	it('leaves plain identifiers untouched', () => {
		expect(translateFilter({ source: 'docs' }).expr).toBe('source = $f0');
		expect(
			translateFilter({ a_1: 1 }, { fieldPrefix: 'metadata' }).expr,
		).toBe('metadata.a_1 = $f0');
	});

	it('keeps dotted paths as paths, escaping each segment', () => {
		expect(translateFilter({ 'a.b.c': 1 }).expr).toBe('a.b.c = $f0');
	});

	it('renders an injected key as a field name, not an expression', () => {
		// The key is caller-controlled and cannot be a bound parameter, so it
		// must end up as an identifier that simply matches nothing.
		const r = translateFilter({ 'x = 1 OR true': 1 });
		expect(r.expr).toBe('⟨x = 1 OR true⟩ = $f0');
		expect(r.expr).not.toMatch(/\bOR\b\s+true\s*=/);
	});

	it('neutralises a statement-terminator key', () => {
		const r = translateFilter(
			{ 'a; REMOVE TABLE docs': 1 },
			{ fieldPrefix: 'metadata' },
		);
		expect(r.expr).toBe('metadata.⟨a; REMOVE TABLE docs⟩ = $f0');
	});

	it('escapes the field for operator forms too', () => {
		const r = translateFilter({ 'bad key': { $gte: 3 } });
		expect(r.expr).toBe('⟨bad key⟩ >= $f0');
	});

	it('escapes the field on $in, $nin and $exists', () => {
		expect(translateFilter({ 'b k': { $in: [1] } }).expr).toBe(
			'⟨b k⟩ INSIDE $f0',
		);
		expect(translateFilter({ 'b k': { $nin: [1] } }).expr).toBe(
			'⟨b k⟩ NOT INSIDE $f0',
		);
		expect(translateFilter({ 'b k': { $exists: true } }).expr).toBe(
			'⟨b k⟩ IS NOT NONE',
		);
	});

	it('escapes the field on a null (IS NONE) comparison', () => {
		expect(translateFilter({ 'b k': null }).expr).toBe('⟨b k⟩ IS NONE');
	});
});
