// Swap this file for `@surrealdb/spectron` once it's on npm.
// API matches the SDK; only the `endpoint` → `baseUrl` rename below changes.
import type {
	ContextResult,
	ForgetResult,
	MemoryQueryResponse,
	ProfileResponse,
	ReflectionResult,
	StructuredState,
} from './models.js';
import { Knowledge } from './namespaces/knowledge.js';
import {
	Entities,
	Lifecycle,
	Sessions,
	Traces,
} from './namespaces/memory.js';
import {
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_MS,
	type FetchLike,
	HttpTransport,
	quotePath,
} from './transport.js';

export interface SpectronConfig {
	context: string;
	apiKey: string;
	/** Defaults to `https://spectron.surrealdb.com`. Override for staging / dev. */
	endpoint?: string;
	timeout?: number;
	maxRetries?: number;
	fetch?: FetchLike;
}

function contextBase(contextId: string): string {
	return `/api/v1/${quotePath(contextId)}`;
}

export class Spectron {
	readonly contextId: string;
	readonly knowledge: Knowledge;
	readonly sessions: Sessions;
	readonly entities: Entities;
	readonly lifecycle: Lifecycle;
	readonly traces: Traces;
	private readonly transport: HttpTransport;
	private readonly base: string;

	constructor(config: SpectronConfig) {
		if (!config.context) {
			throw new Error('SpectronConfig.context is required');
		}
		this.contextId = config.context;
		this.base = contextBase(config.context);
		this.transport = new HttpTransport({
			endpoint: config.endpoint,
			apiKey: config.apiKey,
			timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
			maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
			fetch: config.fetch,
		});
		this.knowledge = new Knowledge(this.transport, config.context);
		this.sessions = new Sessions(this.transport, config.context);
		this.entities = new Entities(this.transport, config.context);
		this.lifecycle = new Lifecycle(this.transport, config.context);
		this.traces = new Traces(this.transport, config.context);
	}

	get endpoint(): string {
		return this.transport.endpoint;
	}
	set endpoint(value: string) {
		this.transport.endpoint = value.replace(/\/+$/, '');
	}

	get apiKey(): string {
		return this.transport.apiKey;
	}
	set apiKey(value: string) {
		if (!value) throw new Error('apiKey must be a non-empty string');
		this.transport.apiKey = value;
	}

	async health(): Promise<void> {
		await this.transport.get('/api/v1/health');
	}

	async query(opts: {
		query: string;
		k?: number;
		sessionId?: string;
	}): Promise<MemoryQueryResponse> {
		const payload: Record<string, unknown> = { query: opts.query };
		if (opts.k !== undefined) payload.k = opts.k;
		if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId;
		const body = await this.transport.post(`${this.base}/query`, {
			json: payload,
		});
		return body as MemoryQueryResponse;
	}

	async context(opts: {
		query: string;
		k?: number;
	}): Promise<ContextResult> {
		const payload: Record<string, unknown> = { query: opts.query };
		if (opts.k !== undefined) payload.k = opts.k;
		const body = await this.transport.post(`${this.base}/context`, {
			json: payload,
		});
		return body as ContextResult;
	}

	async state(): Promise<StructuredState> {
		const body = await this.transport.get(`${this.base}/state`);
		return body as StructuredState;
	}

	async profile(): Promise<ProfileResponse> {
		const body = await this.transport.get(`${this.base}/profile`);
		return body as ProfileResponse;
	}

	async reflect(opts: {
		query: string;
		persist?: boolean;
	}): Promise<ReflectionResult> {
		const body = await this.transport.post(`${this.base}/reflect`, {
			json: { query: opts.query, persist: opts.persist ?? false },
		});
		return body as ReflectionResult;
	}

	async forget(opts: { query: string }): Promise<ForgetResult> {
		const body = await this.transport.post(`${this.base}/forget`, {
			json: { query: opts.query },
		});
		if (typeof body === 'number') return { deleted: body };
		return body as ForgetResult;
	}
}

// Old name; prefer `Spectron`.
export { Spectron as SpectronClient };
