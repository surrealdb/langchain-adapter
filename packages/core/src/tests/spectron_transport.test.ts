import { describe, expect, it, vi } from 'vitest';
import {
	NotFoundError,
	RateLimitError,
	ServerError,
	SpectronError,
} from '../spectron/errors.js';
import { HttpTransport } from '../spectron/transport.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	});
}

function makeTransport(fetchImpl: unknown, maxRetries = 3): HttpTransport {
	return new HttpTransport({
		endpoint: 'https://api.example.test',
		apiKey: 'sk-test',
		maxRetries,
		fetch: fetchImpl as typeof fetch,
	});
}

type FetchArgs = [string | URL | Request, RequestInit?];

function fetchSpy(impl: (...args: FetchArgs) => Promise<Response>) {
	return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
}

describe('HttpTransport', () => {
	it('sets Authorization header and JSON content type', async () => {
		const fetchMock = fetchSpy(async () => jsonResponse({ ok: true }));
		const t = makeTransport(fetchMock as unknown as typeof fetch);
		await t.post('/api/v1/ctx/foo', { json: { a: 1 } });

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0]!;
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-test');
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers.Accept).toBe('application/json');
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe('{"a":1}');
	});

	it('serialises params and skips undefined', async () => {
		const fetchMock = fetchSpy(async () => jsonResponse(null));
		const t = makeTransport(fetchMock as unknown as typeof fetch);
		await t.get('/api/v1/ctx/keywords', {
			params: {
				q: 'hello',
				minDocumentCount: 2,
				sort: undefined,
				page: 0,
			},
		});
		const url = String(fetchMock.mock.calls[0]![0]);
		expect(url).toContain('q=hello');
		expect(url).toContain('minDocumentCount=2');
		expect(url).toContain('page=0');
		expect(url).not.toContain('sort=');
	});

	it('retries GET on 502 then succeeds', async () => {
		const fetchMock = fetchSpy(async () => jsonResponse({ ok: true }))
			.mockResolvedValueOnce(new Response('boom', { status: 502 }))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		const t = new HttpTransport({
			endpoint: 'https://api.example.test',
			apiKey: 'sk-test',
			maxRetries: 3,
			fetch: fetchMock,
		});
		const result = await t.get('/x');
		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does NOT retry POST on 502', async () => {
		const fetchMock = fetchSpy(
			async () => new Response('boom', { status: 502 }),
		).mockResolvedValueOnce(new Response('boom', { status: 502 }));
		const t = makeTransport(fetchMock);
		await expect(t.post('/x', { json: {} })).rejects.toBeInstanceOf(
			ServerError,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('throws NotFoundError for 404', async () => {
		const fetchMock = fetchSpy(async () =>
			jsonResponse(
				{ title: 'Not found', detail: 'missing' },
				{ status: 404 },
			),
		);
		const t = makeTransport(fetchMock);
		await expect(t.get('/x')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('extracts Retry-After for 429', async () => {
		const fetchMock = fetchSpy(
			async () =>
				new Response(JSON.stringify({ title: 'rate limited' }), {
					status: 429,
					headers: {
						'content-type': 'application/json',
						'retry-after': '7',
					},
				}),
		);
		const t = makeTransport(fetchMock);
		const err = (await t
			.get('/x')
			.catch((e: unknown) => e)) as RateLimitError;
		expect(err).toBeInstanceOf(RateLimitError);
		expect(err.retryAfter).toBe(7);
	});

	it('wraps network errors in SpectronError', async () => {
		const fetchMock = fetchSpy(async () => {
			throw new TypeError('fetch failed');
		});
		// 0 retries so it surfaces immediately
		const t = makeTransport(fetchMock, 0);
		await expect(t.post('/x', { json: {} })).rejects.toBeInstanceOf(
			SpectronError,
		);
	});

	it('returns null on 204', async () => {
		const fetchMock = fetchSpy(
			async () => new Response(null, { status: 204 }),
		);
		const t = makeTransport(fetchMock);
		await expect(t.delete('/x')).resolves.toBeNull();
	});

	it('supports mutable endpoint and apiKey', async () => {
		const fetchMock = fetchSpy(async () => jsonResponse({ ok: true }));
		const t = makeTransport(fetchMock);
		t.endpoint = 'https://other.test/';
		t.apiKey = 'sk-rotated';
		await t.get('/foo');
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe('https://other.test/foo');
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-rotated');
	});
});
