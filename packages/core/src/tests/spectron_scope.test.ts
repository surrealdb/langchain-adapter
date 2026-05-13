import { describe, expect, it } from 'vitest';
import { deserialiseScope, serialiseScope } from '../spectron/scope.js';

describe('spectron scope', () => {
	it('serialises object scope to wire array', () => {
		expect(serialiseScope({ org: 'acme', user: 'tobie' })).toEqual([
			{ key: 'org', value: 'acme' },
			{ key: 'user', value: 'tobie' },
		]);
	});

	it('returns undefined for nullish scope', () => {
		expect(serialiseScope()).toBeUndefined();
		expect(serialiseScope(null)).toBeUndefined();
	});

	it('deserialises wire array back to object', () => {
		expect(
			deserialiseScope([
				{ key: 'org', value: 'acme' },
				{ key: 'user', value: 'tobie' },
			]),
		).toEqual({ org: 'acme', user: 'tobie' });
	});

	it('round-trips', () => {
		const original = { org: 'acme', project: 'spectron' };
		const wire = serialiseScope(original);
		expect(deserialiseScope(wire)).toEqual(original);
	});

	it('handles empty wire input', () => {
		expect(deserialiseScope()).toEqual({});
		expect(deserialiseScope(null)).toEqual({});
		expect(deserialiseScope([])).toEqual({});
	});
});
