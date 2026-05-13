export interface SpectronErrorInit {
	status: number;
	title: string;
	detail?: string;
	typeUri?: string;
	instance?: string;
	extensions?: Record<string, unknown>;
}

export class SpectronError extends Error {
	readonly status: number;
	readonly title: string;
	readonly detail?: string;
	readonly typeUri?: string;
	readonly instance?: string;
	readonly extensions: Record<string, unknown>;

	constructor(init: SpectronErrorInit) {
		const msg = init.detail
			? `[${init.status}] ${init.title}: ${init.detail}`
			: `[${init.status}] ${init.title}`;
		super(msg);
		this.name = new.target.name;
		this.status = init.status;
		this.title = init.title;
		this.detail = init.detail;
		this.typeUri = init.typeUri;
		this.instance = init.instance;
		this.extensions = init.extensions ?? {};
	}
}

export class AuthError extends SpectronError {}
export class ScopeError extends SpectronError {}
export class NotFoundError extends SpectronError {}
export class ValidationError extends SpectronError {}
export class ServerError extends SpectronError {}

export class RateLimitError extends SpectronError {
	readonly retryAfter?: number;

	constructor(init: SpectronErrorInit & { retryAfter?: number }) {
		super(init);
		this.retryAfter = init.retryAfter;
	}
}

const STATUS_MAP: Record<
	number,
	new (
		init: SpectronErrorInit,
	) => SpectronError
> = {
	400: ValidationError,
	401: AuthError,
	403: ScopeError,
	404: NotFoundError,
	422: ValidationError,
};

export function errorFromResponse(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): SpectronError {
	let title = 'Spectron request failed';
	let detail: string | undefined;
	let typeUri: string | undefined;
	let instance: string | undefined;
	const extensions: Record<string, unknown> = {};

	if (body && typeof body === 'object' && !Array.isArray(body)) {
		const obj = body as Record<string, unknown>;
		const rawTitle = obj.title ?? obj.message;
		if (typeof rawTitle === 'string' && rawTitle) title = rawTitle;
		if (typeof obj.detail === 'string') detail = obj.detail;
		if (typeof obj.type === 'string') typeUri = obj.type;
		if (typeof obj.instance === 'string') instance = obj.instance;
		for (const [k, v] of Object.entries(obj)) {
			if (
				![
					'status',
					'title',
					'detail',
					'type',
					'instance',
					'message',
				].includes(k)
			) {
				extensions[k] = v;
			}
		}
	} else if (typeof body === 'string' && body) {
		detail = body;
	}

	if (status === 429) {
		let retryAfter: number | undefined;
		const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
		if (raw !== undefined) {
			const parsed = Number(raw);
			if (Number.isFinite(parsed)) retryAfter = parsed;
		}
		return new RateLimitError({
			status,
			title,
			detail,
			typeUri,
			instance,
			extensions,
			retryAfter,
		});
	}

	if (status >= 500) {
		return new ServerError({
			status,
			title,
			detail,
			typeUri,
			instance,
			extensions,
		});
	}

	const Ctor = STATUS_MAP[status] ?? SpectronError;
	return new Ctor({ status, title, detail, typeUri, instance, extensions });
}
