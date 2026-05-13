import { KnowledgeNamespace } from './namespaces/knowledge.js';
import {
	type EntitiesNamespace,
	type LifecycleNamespace,
	MemoryNamespace,
	type SessionsNamespace,
	type TracesNamespace,
} from './namespaces/memory.js';
import {
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_MS,
	type FetchLike,
	HttpTransport,
} from './transport.js';

export interface SpectronConfig {
	context: string;
	apiKey: string;
	endpoint: string;
	timeout?: number;
	maxRetries?: number;
	fetch?: FetchLike;
}

export class SpectronClient {
	readonly contextId: string;
	readonly knowledge: KnowledgeNamespace;
	readonly memory: MemoryNamespace;
	readonly sessions: SessionsNamespace;
	readonly entities: EntitiesNamespace;
	readonly lifecycle: LifecycleNamespace;
	readonly traces: TracesNamespace;
	private readonly transport: HttpTransport;

	constructor(config: SpectronConfig) {
		if (!config.context) {
			throw new Error('SpectronConfig.context is required');
		}
		this.contextId = config.context;
		this.transport = new HttpTransport({
			endpoint: config.endpoint,
			apiKey: config.apiKey,
			timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
			maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
			fetch: config.fetch,
		});
		this.memory = new MemoryNamespace(this.transport, config.context);
		this.knowledge = new KnowledgeNamespace(this.transport, config.context);
		this.sessions = this.memory.sessions;
		this.entities = this.memory.entities;
		this.lifecycle = this.memory.lifecycle;
		this.traces = this.memory.traces;
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

	query(query: string, opts?: { k?: number; sessionId?: string }) {
		return this.memory.query(query, opts);
	}
	context(query: string, opts?: { k?: number }) {
		return this.memory.context(query, opts);
	}
	state() {
		return this.memory.state();
	}
	profile() {
		return this.memory.profile();
	}
	reflect(query: string, opts?: { persist?: boolean }) {
		return this.memory.reflect(query, opts);
	}
	forget(query: string) {
		return this.memory.forget(query);
	}
}
