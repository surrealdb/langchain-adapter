import type {
	ChatReply,
	ContextResult,
	Entity,
	EntityHistoryEntry,
	ExtractionResult,
	SessionInfo,
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

export class Session {
	private readonly base: string;
	readonly id: string;

	constructor(
		private readonly transport: HttpTransport,
		readonly contextId: string,
		readonly info: SessionInfo,
	) {
		this.id = info.id;
		this.base = `${enduserBase(contextId)}/sessions/${quotePath(info.id)}`;
	}

	async close(): Promise<void> {
		await this.transport.delete(this.base);
	}

	async turn(opts: {
		role: TurnRole;
		content: string;
	}): Promise<ExtractionResult> {
		const body = await this.transport.post(`${this.base}/turns`, {
			json: { role: opts.role, content: opts.content },
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

	async context(opts: { query: string; k?: number }): Promise<ContextResult> {
		const payload: Record<string, unknown> = { query: opts.query };
		if (opts.k !== undefined) payload.k = opts.k;
		const body = await this.transport.post(`${this.base}/context`, {
			json: payload,
		});
		return body as ContextResult;
	}

	async chat(opts: { message: string }): Promise<ChatReply> {
		const body = await this.transport.post(`${this.base}/chat`, {
			json: { message: opts.message },
		});
		return body as ChatReply;
	}
}

export class Sessions {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		private readonly contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/sessions`;
	}

	async create(
		opts: {
			scope?: Record<string, string>;
			metadata?: Record<string, unknown>;
		} = {},
	): Promise<Session> {
		const payload: Record<string, unknown> = {};
		const scope = serialiseScope(opts.scope);
		if (scope !== undefined) payload.scope = scope;
		if (opts.metadata !== undefined) payload.metadata = { ...opts.metadata };
		const body = await this.transport.post(this.base, { json: payload });
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new Error(
				`Expected JSON object from session create, got ${body === null ? 'null' : typeof body}`,
			);
		}
		return new Session(this.transport, this.contextId, body as SessionInfo);
	}
}

export class Entities {
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

export class Lifecycle {
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

export class Traces {
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
