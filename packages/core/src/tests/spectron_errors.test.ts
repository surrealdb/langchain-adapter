import { describe, expect, it } from 'vitest';
import {
	AuthError,
	errorFromResponse,
	NotFoundError,
	RateLimitError,
	ScopeError,
	ServerError,
	SpectronError,
	ValidationError,
} from '../spectron/errors.js';

describe('spectron errors', () => {
	it('maps 401/403/404/422/500 to specific subclasses', () => {
		expect(errorFromResponse(401, { title: 'x' })).toBeInstanceOf(
			AuthError,
		);
		expect(errorFromResponse(403, { title: 'x' })).toBeInstanceOf(
			ScopeError,
		);
		expect(errorFromResponse(404, { title: 'x' })).toBeInstanceOf(
			NotFoundError,
		);
		expect(errorFromResponse(400, { title: 'x' })).toBeInstanceOf(
			ValidationError,
		);
		expect(errorFromResponse(422, { title: 'x' })).toBeInstanceOf(
			ValidationError,
		);
		expect(errorFromResponse(500, { title: 'x' })).toBeInstanceOf(
			ServerError,
		);
		expect(errorFromResponse(502, { title: 'x' })).toBeInstanceOf(
			ServerError,
		);
	});

	it('falls back to SpectronError for unknown status', () => {
		const err = errorFromResponse(418, { title: 'teapot' });
		expect(err).toBeInstanceOf(SpectronError);
		expect(err).not.toBeInstanceOf(AuthError);
		expect(err.status).toBe(418);
	});

	it('parses RFC7807-style problem body', () => {
		const err = errorFromResponse(404, {
			title: 'Document not found',
			detail: 'No document with id doc:xxx',
			type: 'about:blank',
			instance: '/api/v1/ctx/knowledge/doc:xxx',
			extra: 'bonus',
		});
		expect(err.title).toBe('Document not found');
		expect(err.detail).toBe('No document with id doc:xxx');
		expect(err.typeUri).toBe('about:blank');
		expect(err.instance).toBe('/api/v1/ctx/knowledge/doc:xxx');
		expect(err.extensions).toEqual({ extra: 'bonus' });
	});

	it('reads Retry-After for 429', () => {
		const err = errorFromResponse(
			429,
			{ title: 'Too many requests' },
			{ 'retry-after': '2.5' },
		) as RateLimitError;
		expect(err).toBeInstanceOf(RateLimitError);
		expect(err.retryAfter).toBe(2.5);
	});

	it('handles non-object bodies', () => {
		const err = errorFromResponse(500, 'boom');
		expect(err.detail).toBe('boom');
		const nullErr = errorFromResponse(500, null);
		expect(nullErr.detail).toBeUndefined();
	});
});
