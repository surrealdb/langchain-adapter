import type {
	ChunkPageJson,
	DocumentJson,
	DocumentKeywordJson,
	DocumentPageJson,
	KeywordDetailJson,
	KeywordPageJson,
	KeywordSearchResponseJson,
	KnowledgeLinkUpsert,
	KnowledgeNodeFullJson,
	KnowledgeNodePageJson,
	KnowledgeNodeSearchResponseJson,
	KnowledgeNodeUpsertRow,
	QueryFilter,
	QueryMode,
	QueryResponseJson,
	TraverseApiResponse,
	TraverseStartJson,
	UploadResponse,
} from '../models.js';
import { serialiseScope } from '../scope.js';
import {
	buildMultipart,
	type HttpTransport,
	quotePath,
	type SpectronFileInput,
} from '../transport.js';

function enduserBase(contextId: string): string {
	return `/api/v1/${quotePath(contextId)}`;
}

function uploadFields(args: {
	title?: string;
	profile?: string;
	scope?: Record<string, string>;
}): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	if (args.title !== undefined) fields.title = args.title;
	if (args.profile !== undefined) fields.profile = args.profile;
	const scope = serialiseScope(args.scope);
	if (scope !== undefined) fields.scope = scope;
	return fields;
}

export interface QueryOptions {
	query: string;
	mode?: QueryMode;
	k?: number;
	threshold?: number;
	vectorWeight?: number;
	rrfK?: number;
	graphAlpha?: number;
	graphEdges?: string[];
	graphDepth?: number;
	expandGraph?: boolean;
	filter?: QueryFilter | Record<string, unknown>;
}

function buildQueryPayload(opts: QueryOptions): Record<string, unknown> {
	const payload: Record<string, unknown> = { query: opts.query };
	if (opts.mode !== undefined) payload.mode = opts.mode;
	if (opts.k !== undefined) payload.k = opts.k;
	if (opts.threshold !== undefined) payload.threshold = opts.threshold;
	if (opts.vectorWeight !== undefined) payload.vectorWeight = opts.vectorWeight;
	if (opts.rrfK !== undefined) payload.rrfK = opts.rrfK;
	if (opts.graphAlpha !== undefined) payload.graphAlpha = opts.graphAlpha;
	if (opts.graphEdges !== undefined) payload.graphEdges = [...opts.graphEdges];
	if (opts.graphDepth !== undefined) payload.graphDepth = opts.graphDepth;
	if (opts.expandGraph !== undefined) payload.expandGraph = opts.expandGraph;
	if (opts.filter !== undefined) payload.filter = opts.filter;
	return payload;
}

export interface TraverseOptions {
	start: TraverseStartJson[];
	edges: string[];
	direction?: string;
	labels?: string[];
	maxDepth?: number;
	limitPerHop?: number;
	minScore?: number;
}

function buildTraversePayload(opts: TraverseOptions): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		start: opts.start.map((s) => ({ ...s })),
		edges: [...opts.edges],
	};
	if (opts.direction !== undefined) payload.direction = opts.direction;
	if (opts.labels !== undefined) payload.labels = [...opts.labels];
	if (opts.maxDepth !== undefined) payload.maxDepth = opts.maxDepth;
	if (opts.limitPerHop !== undefined) payload.limitPerHop = opts.limitPerHop;
	if (opts.minScore !== undefined) payload.minScore = opts.minScore;
	return payload;
}

export class KnowledgeKeywords {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/knowledge/keywords`;
	}

	async list(
		opts: {
			q?: string;
			minDocumentCount?: number;
			sort?: string;
			page?: number;
			pageSize?: number;
		} = {},
	): Promise<KeywordPageJson> {
		const body = await this.transport.get(this.base, {
			params: {
				q: opts.q,
				minDocumentCount: opts.minDocumentCount,
				sort: opts.sort,
				page: opts.page,
				pageSize: opts.pageSize,
			},
		});
		return body as KeywordPageJson;
	}

	async search(opts: {
		query: string;
		k?: number;
		threshold?: number;
	}): Promise<KeywordSearchResponseJson> {
		const payload: Record<string, unknown> = { query: opts.query };
		if (opts.k !== undefined) payload.k = opts.k;
		if (opts.threshold !== undefined) payload.threshold = opts.threshold;
		const body = await this.transport.post(`${this.base}/search`, {
			json: payload,
		});
		return body as KeywordSearchResponseJson;
	}

	async get(normalised: string): Promise<KeywordDetailJson> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(normalised)}`,
		);
		return body as KeywordDetailJson;
	}

	async related(normalised: string): Promise<TraverseApiResponse> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(normalised)}/related`,
		);
		return body as TraverseApiResponse;
	}

	async forDocument(documentId: string): Promise<DocumentKeywordJson[]> {
		const docBase = this.base.replace(/\/keywords$/, '');
		const body = await this.transport.get(
			`${docBase}/${quotePath(documentId)}/keywords`,
		);
		const obj = body as { keywords?: DocumentKeywordJson[] } | null;
		return obj?.keywords ?? [];
	}
}

export interface NodesUpsertOptions {
	nodes: KnowledgeNodeUpsertRow[];
	relations?: KnowledgeLinkUpsert[];
	scope?: Record<string, string>;
}

export class KnowledgeNodes {
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/knowledge/nodes`;
	}

	async list(
		opts: {
			kind?: string;
			q?: string;
			page?: number;
			pageSize?: number;
		} = {},
	): Promise<KnowledgeNodePageJson> {
		const body = await this.transport.get(this.base, {
			params: {
				kind: opts.kind,
				q: opts.q,
				page: opts.page,
				pageSize: opts.pageSize,
			},
		});
		return body as KnowledgeNodePageJson;
	}

	async upsert(opts: NodesUpsertOptions): Promise<void> {
		const payload: Record<string, unknown> = {
			nodes: opts.nodes.map((n) => ({ ...n })),
		};
		if (opts.relations !== undefined) {
			payload.relations = opts.relations.map((r) => ({ ...r }));
		}
		const scope = serialiseScope(opts.scope);
		if (scope !== undefined) payload.scope = scope;
		await this.transport.post(`${this.base}/batch`, { json: payload });
	}

	async search(opts: {
		query: string;
		k?: number;
		threshold?: number;
		rrfK?: number;
		vectorWeight?: number;
		kindFilter?: string;
	}): Promise<KnowledgeNodeSearchResponseJson> {
		const payload: Record<string, unknown> = {
			query: opts.query,
			k: opts.k ?? 10,
			threshold: opts.threshold ?? 0.0,
		};
		if (opts.rrfK !== undefined) payload.rrfK = opts.rrfK;
		if (opts.vectorWeight !== undefined) payload.vectorWeight = opts.vectorWeight;
		if (opts.kindFilter !== undefined) payload.kindFilter = opts.kindFilter;
		const body = await this.transport.post(`${this.base}/search`, {
			json: payload,
		});
		return body as KnowledgeNodeSearchResponseJson;
	}

	async get(kind: string, slug: string): Promise<KnowledgeNodeFullJson> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(kind)}/${quotePath(slug)}`,
		);
		return body as KnowledgeNodeFullJson;
	}

	async related(
		kind: string,
		slug: string,
		opts: { label?: string; depth?: number } = {},
	): Promise<TraverseApiResponse> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(kind)}/${quotePath(slug)}/related`,
			{ params: { label: opts.label, depth: opts.depth } },
		);
		return body as TraverseApiResponse;
	}

	async delete(kind: string, slug: string): Promise<void> {
		await this.transport.delete(
			`${this.base}/${quotePath(kind)}/${quotePath(slug)}`,
		);
	}
}

export interface UploadOptions {
	file: SpectronFileInput;
	title?: string;
	profile?: string;
	scope?: Record<string, string>;
	filename?: string;
	mimeType?: string;
}

export class Knowledge {
	readonly keywords: KnowledgeKeywords;
	readonly nodes: KnowledgeNodes;
	private readonly base: string;

	constructor(
		private readonly transport: HttpTransport,
		contextId: string,
	) {
		this.base = `${enduserBase(contextId)}/knowledge`;
		this.keywords = new KnowledgeKeywords(transport, contextId);
		this.nodes = new KnowledgeNodes(transport, contextId);
	}

	async upload(opts: UploadOptions): Promise<UploadResponse> {
		const form = buildMultipart({
			file: opts.file,
			filename: opts.filename,
			mimeType: opts.mimeType,
			fields: uploadFields({
				title: opts.title,
				profile: opts.profile,
				scope: opts.scope,
			}),
		});
		const body = await this.transport.post(this.base, { body: form });
		return body as UploadResponse;
	}

	async replace(
		documentId: string,
		opts: Omit<UploadOptions, 'scope'>,
	): Promise<UploadResponse> {
		const form = buildMultipart({
			file: opts.file,
			filename: opts.filename,
			mimeType: opts.mimeType,
			fields: uploadFields({ title: opts.title, profile: opts.profile }),
		});
		const body = await this.transport.put(
			`${this.base}/${quotePath(documentId)}`,
			{ body: form },
		);
		return (
			(body as UploadResponse | null) ?? {
				id: documentId,
				status: 'queued',
				contentHash: '',
				deduplicated: false,
			}
		);
	}

	async get(documentId: string): Promise<DocumentJson> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(documentId)}`,
		);
		return body as DocumentJson;
	}

	raw(documentId: string): Promise<Uint8Array> {
		return this.transport.rawBytes(
			`${this.base}/${quotePath(documentId)}/raw`,
		);
	}

	async chunks(
		documentId: string,
		opts: { page?: number; pageSize?: number } = {},
	): Promise<ChunkPageJson> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(documentId)}/chunks`,
			{ params: { page: opts.page, page_size: opts.pageSize } },
		);
		return body as ChunkPageJson;
	}

	async list(
		opts: {
			status?: string;
			mimeType?: string;
			page?: number;
			pageSize?: number;
		} = {},
	): Promise<DocumentPageJson> {
		const body = await this.transport.get(this.base, {
			params: {
				status: opts.status,
				mime_type: opts.mimeType,
				page: opts.page,
				page_size: opts.pageSize,
			},
		});
		return body as DocumentPageJson;
	}

	async related(documentId: string): Promise<TraverseApiResponse> {
		const body = await this.transport.get(
			`${this.base}/${quotePath(documentId)}/related`,
		);
		return body as TraverseApiResponse;
	}

	async delete(documentId: string): Promise<void> {
		await this.transport.delete(`${this.base}/${quotePath(documentId)}`);
	}

	async query(opts: QueryOptions): Promise<QueryResponseJson> {
		const body = await this.transport.post(`${this.base}/query`, {
			json: buildQueryPayload(opts),
		});
		return body as QueryResponseJson;
	}

	async traverse(opts: TraverseOptions): Promise<TraverseApiResponse> {
		const body = await this.transport.post(`${this.base}/traverse`, {
			json: buildTraversePayload(opts),
		});
		return body as TraverseApiResponse;
	}

	async traverseRecursive(opts: {
		start: TraverseStartJson;
		edge: string;
		maxDepth?: number;
		direction?: string;
	}): Promise<TraverseApiResponse> {
		const payload: Record<string, unknown> = {
			start: { ...opts.start },
			edge: opts.edge,
			maxDepth: opts.maxDepth ?? 3,
		};
		if (opts.direction !== undefined) payload.direction = opts.direction;
		const body = await this.transport.post(
			`${this.base}/traverse/recursive`,
			{ json: payload },
		);
		return body as TraverseApiResponse;
	}

	async traverseSiblings(opts: {
		start: TraverseStartJson;
		edge: string;
	}): Promise<TraverseApiResponse> {
		const body = await this.transport.post(`${this.base}/traverse/siblings`, {
			json: { start: { ...opts.start }, edge: opts.edge },
		});
		return body as TraverseApiResponse;
	}
}
