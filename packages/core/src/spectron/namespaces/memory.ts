import type {
	ChatReply,
	ContextResult,
	Entity,
	EntityHistoryEntry,
	ExtractionResult,
	ForgetResult,
	MemoryQueryResponse,
	ProfileResponse,
	ReflectionResult,
	SessionInfo,
	StructuredState,
	TraceListResponse,
	TraceRecord,
	TraceStats,
	Turn,
	TurnRole,
} from '../models.js';
import { serialiseScope } from '../scope.js';
import { type HttpTransport, quotePath } from '../transport.js';

function enduserBase(contextId: string): string {
	return `/api/v1/${quotePath(contextId)}`;
}

function sessionCreatePayload(args: {
	scope?: Record<string, string>;
	metadata?: Record<string, unknown>;
}): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	const scope = serialiseScope(args.scope);
	if (scope !== undefined) payload.scope = scope;
	if (args.metadata !== undefined) payload.metadata = { ...args.metadata };
	return payload;
}

function turnPayload(role: TurnRole, content: string): Record<string, unknown> {
	return { role, content };
}

function contextPayload(query: string, k?: number): Record<string, unknown> {
	const p: Record<string, unknown> = { query };
	if (k !== undefined) p.k = k;
	return p;
}

export class Session {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		readonly contextId: string,
		readonly info: SessionInfo,
	) {
		this.base = `${enduserBase(contextId)}/sessions/${quotePath(info.id)}`;
	}

	get id(): string {
		return this.info.id;
	}

	async close(): Promise<void> {
		await this.transport.delete(this.base);
	}

	async turn(role: TurnRole, content: string): Promise<ExtractionResult> {
		const body = await this.transport.post(`${this.base}/turns`, {
			json: turnPayload(role, content),
		});
		return body as ExtractionResult;
	}

	async turns(): Promise<Turn[]> {
		const body = await this.transport.get(`${this.base}/turns`);
		if (
			body &&
			typeof body === 'object' &&
			'turns' in (body as Record<string, unknown>)
		) {
			const arr = (body as { turns?: Turn[] }).turns;
			return Array.isArray(arr) ? arr : [];
		}
		return Array.isArray(body) ? (body as Turn[]) : [];
	}

	async context(
		query: string,
		opts: { k?: number } = {},
	): Promise<ContextResult> {
		const body = await this.transport.post(`${this.base}/context`, {
			json: contextPayload(query, opts.k),
		});
		return body as ContextResult;
	}

	async chat(message: string): Promise<ChatReply> {
		const body = await this.transport.post(`${this.base}/chat`, {
			json: { message },
		});
		return body as ChatReply;
	}
}

export class SessionsNamespace {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		private readonly contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/sessions`;
	}

	async create(
		args: {
			scope?: Record<string, string>;
			metadata?: Record<string, unknown>;
		} = {},
	): Promise<Session> {
		const body = await this.transport.post(this.base, {
			json: sessionCreatePayload(args),
		});
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new Error(
				`Expected JSON object from session create, got ${body === null ? 'null' : typeof body}`,
			);
		}
		const info = body as SessionInfo;
		return new Session(this.transport, this.contextId, info);
	}
}

export class EntitiesNamespace {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/entities`;
	}

	async list(opts: { type?: string } = {}): Promise<Entity[]> {
		const body = await this.transport.get(this.base, {
			params: { type: opts.type },
		});
		if (
			body &&
			typeof body === 'object' &&
			'entities' in (body as Record<string, unknown>)
		) {
			const arr = (body as { entities?: Entity[] }).entities;
			return Array.isArray(arr) ? arr : [];
		}
		return Array.isArray(body) ? (body as Entity[]) : [];
	}

	async get(type: string, name: string): Promise<Entity> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(type)}/${quotePath(name)}`,
		);
		return body as Entity;
	}

	async history(
		type: string,
		name: string,
		key: string,
	): Promise<EntityHistoryEntry[]> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(type)}/${quotePath(name)}/history/${quotePath(key)}`,
		);
		if (
			body &&
			typeof body === 'object' &&
			'history' in (body as Record<string, unknown>)
		) {
			const arr = (body as { history?: EntityHistoryEntry[] }).history;
			return Array.isArray(arr) ? arr : [];
		}
		return Array.isArray(body) ? (body as EntityHistoryEntry[]) : [];
	}

	async delete(type: string, name: string): Promise<void> {
		await this.transport.delete(
			`${this.base}/${quotePath(type)}/${quotePath(name)}`,
		);
	}
}

export class LifecycleNamespace {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/lifecycle`;
	}

	async expire(): Promise<void> {
		await this.transport.post(`${this.base}/expire`, { json: {} });
	}

	async decay(): Promise<void> {
		await this.transport.post(`${this.base}/decay`, { json: {} });
	}
}

export class TracesNamespace {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/traces`;
	}

	async list(opts: { limit?: number } = {}): Promise<TraceRecord[]> {
		const body = await this.transport.get(this.base, {
			params: { limit: opts.limit },
		});
		if (
			body &&
			typeof body === 'object' &&
			'traces' in (body as Record<string, unknown>)
		) {
			return (body as TraceListResponse).traces ?? [];
		}
		return Array.isArray(body) ? (body as TraceRecord[]) : [];
	}

	async get(traceId: string): Promise<TraceRecord> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(traceId)}`,
		);
		return body as TraceRecord;
	}

	async stats(): Promise<TraceStats> {
		const body = await this.transport.get(`${this.base}/stats`);
		return body as TraceStats;
	}
}

export class MemoryNamespace {
	readonly sessions: SessionsNamespace;
	readonly entities: EntitiesNamespace;
	readonly lifecycle: LifecycleNamespace;
	readonly traces: TracesNamespace;
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = enduserBase(contextId);
		this.sessions = new SessionsNamespace(transport, contextId);
		this.entities = new EntitiesNamespace(transport, contextId);
		this.lifecycle = new LifecycleNamespace(transport, contextId);
		this.traces = new TracesNamespace(transport, contextId);
	}

	async query(
		query: string,
		opts: { k?: number; sessionId?: string } = {},
	): Promise<MemoryQueryResponse> {
		const payload: Record<string, unknown> = { query };
		if (opts.k !== undefined) payload.k = opts.k;
		if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId;
		const body = await this.transport.post(`${this.base}/query`, {
			json: payload,
		});
		return body as MemoryQueryResponse;
	}

	async context(
		query: string,
		opts: { k?: number } = {},
	): Promise<ContextResult> {
		const body = await this.transport.post(`${this.base}/context`, {
			json: contextPayload(query, opts.k),
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

	async reflect(
		query: string,
		opts: { persist?: boolean } = {},
	): Promise<ReflectionResult> {
		const body = await this.transport.post(`${this.base}/reflect`, {
			json: { query, persist: opts.persist ?? false },
		});
		return body as ReflectionResult;
	}

	async forget(query: string): Promise<ForgetResult> {
		const body = await this.transport.post(`${this.base}/forget`, {
			json: { query },
		});
		if (typeof body === 'number') return { deleted: body };
		return body as ForgetResult;
	}
}
