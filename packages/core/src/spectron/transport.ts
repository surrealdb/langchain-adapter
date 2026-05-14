import { errorFromResponse, SpectronError } from './errors.js';
import { backoffSchedule, shouldRetry } from './retry.js';

export const DEFAULT_ENDPOINT = 'https://spectron.surrealdb.com';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
const USER_AGENT = 'surrealdb-js-spectron/0.1';

export type FetchLike = typeof fetch;
type FetchBody = NonNullable<Parameters<FetchLike>[1]>['body'];

export interface HttpTransportConfig {
	endpoint?: string;
	apiKey: string;
	timeout?: number;
	maxRetries?: number;
	fetch?: FetchLike;
}

export interface RequestOptions {
	params?: Record<string, unknown>;
	json?: unknown;
	body?: FetchBody;
	headers?: Record<string, string>;
	timeout?: number;
	returnRaw?: boolean;
	signal?: AbortSignal;
}

function buildUrl(
	endpoint: string,
	path: string,
	params?: Record<string, unknown>,
): string {
	const isAbsolute = /^https?:\/\//i.test(path);
	const base = endpoint.replace(/\/+$/, '');
	const rel = path.startsWith('/') ? path : `/${path}`;
	const url = new URL(isAbsolute ? path : base + rel);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined || v === null) continue;
			if (Array.isArray(v)) {
				for (const item of v) url.searchParams.append(k, String(item));
			} else {
				url.searchParams.append(k, String(v));
			}
		}
	}
	return url.toString();
}

function headersToRecord(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	h.forEach((v, k) => {
		out[k.toLowerCase()] = v;
	});
	return out;
}

async function decodeBody(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function quotePath(value: string): string {
	return encodeURIComponent(String(value));
}

export class HttpTransport {
	endpoint: string;
	apiKey: string;
	timeout: number;
	maxRetries: number;
	private readonly fetchImpl: FetchLike;

	constructor(config: HttpTransportConfig) {
		if (!config.apiKey) {
			throw new Error('Spectron API key is required. Pass apiKey=...');
		}
		this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
		this.apiKey = config.apiKey;
		this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
		if (typeof this.fetchImpl !== 'function') {
			throw new Error(
				'No fetch implementation available. Pass `fetch` in SpectronConfig.',
			);
		}
	}

	private buildHeaders(
		extra: Record<string, string> | undefined,
		hasJsonBody: boolean,
		hasFormBody: boolean,
	): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
		};
		if (hasJsonBody && !hasFormBody)
			headers['Content-Type'] = 'application/json';
		if (extra) {
			for (const [k, v] of Object.entries(extra)) headers[k] = v;
		}
		return headers;
	}

	async request(
		method: string,
		path: string,
		opts: RequestOptions = {},
	): Promise<unknown> {
		const url = buildUrl(this.endpoint, path, opts.params);
		const methodUpper = method.toUpperCase();
		const isJson = opts.json !== undefined;
		const isForm = opts.body instanceof FormData;
		const headers = this.buildHeaders(opts.headers, isJson, isForm);

		let body: FetchBody;
		if (isJson) body = JSON.stringify(opts.json);
		else if (opts.body !== undefined && opts.body !== null)
			body = opts.body;

		const schedule = backoffSchedule(this.maxRetries);
		let attempt = 0;

		while (true) {
			const ac = new AbortController();
			const timeoutMs = opts.timeout ?? this.timeout;
			const timer = setTimeout(() => ac.abort(), timeoutMs);
			const userSignal = opts.signal;
			const onAbort = () => ac.abort();
			if (userSignal) {
				if (userSignal.aborted) ac.abort();
				else
					userSignal.addEventListener('abort', onAbort, {
						once: true,
					});
			}

			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method: methodUpper,
					headers,
					body,
					signal: ac.signal,
				});
			} catch (err) {
				clearTimeout(timer);
				if (userSignal)
					userSignal.removeEventListener('abort', onAbort);
				if (!shouldRetry(methodUpper, null, attempt, this.maxRetries)) {
					throw new SpectronError({
						status: 0,
						title: 'Connection failed',
						detail:
							err instanceof Error ? err.message : String(err),
					});
				}
				await sleep(schedule[attempt] ?? 0);
				attempt += 1;
				continue;
			}
			clearTimeout(timer);
			if (userSignal) userSignal.removeEventListener('abort', onAbort);

			const status = response.status;
			if (
				status >= 400 &&
				shouldRetry(methodUpper, status, attempt, this.maxRetries)
			) {
				// Drain so connection can be reused.
				await response.text().catch(() => undefined);
				await sleep(schedule[attempt] ?? 0);
				attempt += 1;
				continue;
			}

			if (status >= 400) {
				const body = await decodeBody(response);
				throw errorFromResponse(
					status,
					body,
					headersToRecord(response.headers),
				);
			}

			if (opts.returnRaw) return response;
			if (status === 204) return null;
			return decodeBody(response);
		}
	}

	get(path: string, opts: RequestOptions = {}): Promise<unknown> {
		return this.request('GET', path, opts);
	}
	post(path: string, opts: RequestOptions = {}): Promise<unknown> {
		return this.request('POST', path, opts);
	}
	put(path: string, opts: RequestOptions = {}): Promise<unknown> {
		return this.request('PUT', path, opts);
	}
	patch(path: string, opts: RequestOptions = {}): Promise<unknown> {
		return this.request('PATCH', path, opts);
	}
	delete(path: string, opts: RequestOptions = {}): Promise<unknown> {
		return this.request('DELETE', path, opts);
	}

	async rawBytes(
		path: string,
		opts: RequestOptions = {},
	): Promise<Uint8Array> {
		const res = (await this.request('GET', path, {
			...opts,
			returnRaw: true,
		})) as Response;
		const buf = await res.arrayBuffer();
		return new Uint8Array(buf);
	}
}

export type SpectronFileInput =
	| Blob
	| ArrayBuffer
	| ArrayBufferView
	| Uint8Array
	| string;

export interface BuildMultipartArgs {
	file: SpectronFileInput;
	filename?: string;
	mimeType?: string;
	fields?: Record<string, unknown>;
}

export function buildMultipart({
	file,
	filename,
	mimeType,
	fields,
}: BuildMultipartArgs): FormData {
	const form = new FormData();
	const type = mimeType ?? 'application/octet-stream';
	let blob: Blob;
	let name = filename;

	if (typeof file === 'string') {
		throw new Error(
			'String file paths are not supported in the Spectron JS client. ' +
				'Read the file yourself (e.g. via node:fs/promises.readFile) and pass a Uint8Array, ArrayBuffer or Blob.',
		);
	}
	if (file instanceof Blob) {
		blob = file;
		if (!name && typeof (file as File).name === 'string')
			name = (file as File).name;
	} else if (file instanceof ArrayBuffer) {
		blob = new Blob([file], { type });
	} else if (ArrayBuffer.isView(file)) {
		const ab = file.buffer.slice(
			file.byteOffset,
			file.byteOffset + file.byteLength,
		) as ArrayBuffer;
		blob = new Blob([ab], { type });
	} else {
		throw new Error(`Unsupported file input type: ${typeof file}`);
	}

	form.append('file', blob, name ?? 'upload');

	if (fields) {
		for (const [k, v] of Object.entries(fields)) {
			if (v === undefined || v === null) continue;
			if (typeof v === 'object') {
				form.append(k, JSON.stringify(v));
			} else {
				form.append(k, String(v));
			}
		}
	}

	return form;
}
