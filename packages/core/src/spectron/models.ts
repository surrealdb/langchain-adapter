export type QueryMode = 'vector' | 'bm25' | 'hybrid' | 'hybrid_graph';

export type DocumentStatus =
	| 'queued'
	| 'extracting'
	| 'chunking'
	| 'embedding'
	| 'rendering'
	| 'transcribing'
	| 'captioning'
	| 'keywording'
	| 'ready'
	| 'failed';

export type IngestProfile =
	| 'text_only'
	| 'text_plus_ocr'
	| 'multimodal_balanced'
	| 'multimodal_full';

export type TurnRole = 'user' | 'assistant' | 'system' | 'tool';

export type MemoryCategory =
	| 'identity'
	| 'knowledge'
	| 'context'
	| 'instruction'
	| 'uncertainty';

export interface ChunkJson {
	id: string;
	document: string;
	position: number;
	charStart: number;
	charEnd: number;
	text: string;
	section?: string | null;
	tokenCount?: number | null;
}

export interface ChunkPageJson {
	chunks: ChunkJson[];
	page: number;
	pageSize: number;
	total: number;
}

export interface DocumentJson {
	id: string;
	title: string;
	source: string;
	mimeType: string;
	contentHash: string;
	sizeBytes: number;
	status: string;
	version: number;
	createdAt: string;
	updatedAt: string;
	chunkCount?: number | null;
	error?: string | null;
	keywordCount?: number | null;
	language?: string | null;
	processingCompletedAt?: string | null;
	processingStartedAt?: string | null;
}

export interface DocumentPageJson {
	documents: DocumentJson[];
	page: number;
	pageSize: number;
	total: number;
}

export interface DocumentKeywordJson {
	id: string;
	normalised: string;
	score: number;
	text: string;
}

export interface DocumentKeywordsResponse {
	keywords: DocumentKeywordJson[];
}

export interface KeywordJson {
	id: string;
	normalised: string;
	text: string;
	documentCount: number;
}

export interface KeywordPageJson {
	keywords: KeywordJson[];
	page: number;
	pageSize: number;
	total: number;
}

export interface KeywordDocumentJson {
	id: string;
	score: number;
	title: string;
}

export interface KeywordDetailJson {
	id: string;
	normalised: string;
	text: string;
	documentCount: number;
	documents: KeywordDocumentJson[];
}

export interface KeywordSearchHitJson {
	id: string;
	normalised: string;
	text: string;
	score: number;
	documentCount: number;
}

export interface KeywordSearchResponseJson {
	queryMs: number;
	results: KeywordSearchHitJson[];
}

export interface KnowledgeLinkTarget {
	kind: string;
	slug: string;
}

export interface KnowledgeLinkUpsert {
	label: string;
	to: KnowledgeLinkTarget;
}

export interface KnowledgeNodeUpsertRow {
	kind: string;
	slug: string;
	title: string;
	content?: Record<string, unknown>;
	links?: KnowledgeLinkUpsert[];
	sourceDocument?: string;
}

export interface KnowledgeSummaryJson {
	id: string;
	kind: string;
	title: string;
}

export interface KnowledgeNodeListedJson {
	id: string;
	kind: string;
	title: string;
	content: Record<string, unknown>;
	scope: string[];
	createdAt: string;
	updatedAt: string;
	sourceDocument?: string | null;
}

export interface KnowledgeNodeFullJson {
	id: string;
	kind: string;
	title: string;
	content: Record<string, unknown>;
	embedding: number[];
	scope: string[];
	createdAt: string;
	updatedAt: string;
	sourceDocument?: string | null;
}

export interface KnowledgeNodePageJson {
	nodes: KnowledgeNodeListedJson[];
	page: number;
	pageSize: number;
	total: number;
}

export interface KnowledgeNodeSearchHitJson {
	node: KnowledgeSummaryJson;
	score: number;
}

export interface KnowledgeNodeSearchResponseJson {
	queryMs: number;
	results: KnowledgeNodeSearchHitJson[];
}

export interface QueryFilter {
	documentIds?: string[];
	mimeType?: string[];
	scope?: Record<string, string>;
	[key: string]: unknown;
}

export interface QueryHitChunkJson {
	id: string;
	document: string;
	position: number;
	charStart: number;
	charEnd: number;
	text: string;
	section?: string | null;
}

export interface QueryHitDocumentJson {
	id: string;
	title: string;
	source: string;
}

export interface GraphEvidenceJson {
	edgeKind: string;
	neighbourLabel: string;
	weight: number;
}

export interface QueryHitJson {
	chunk: QueryHitChunkJson;
	document: QueryHitDocumentJson;
	score: number;
	graphEvidence?: GraphEvidenceJson[] | null;
	graphExpansion?: Record<string, unknown> | null;
}

export interface QueryResponseJson {
	queryMs: number;
	results: QueryHitJson[];
}

export interface TraverseStartJson {
	type: string;
	id?: string;
	normalised?: string;
	kind?: string;
	slug?: string;
}

export interface TraverseNodeJson {
	id: string;
	type: string;
	depth: number;
	kind?: string | null;
	normalised?: string | null;
	title?: string | null;
}

export interface TraverseEdgeJson {
	kind: string;
	from: string;
	to: string;
	label?: string | null;
	score?: number | null;
}

export interface TraverseApiResponse {
	nodes: TraverseNodeJson[];
	edges: TraverseEdgeJson[];
}

export interface UploadResponse {
	id: string;
	status: string;
	contentHash: string;
	deduplicated: boolean;
}

export interface SessionInfo {
	id: string;
	scope?: Record<string, string> | null;
	metadata?: Record<string, unknown> | null;
	createdAt?: string | null;
}

export interface Turn {
	role: TurnRole;
	content: string;
	id?: string | null;
	createdAt?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface EntityRef {
	type: string;
	name: string;
}

export interface AttributeUpdate {
	entity: EntityRef;
	key: string;
	value: unknown;
	category?: MemoryCategory | null;
	confidence?: number | null;
}

export interface RelationUpdate {
	label: string;
	source: EntityRef;
	target: EntityRef;
	confidence?: number | null;
}

export interface ExtractionResult {
	entities?: EntityRef[] | null;
	attributes?: AttributeUpdate[] | null;
	relations?: RelationUpdate[] | null;
	instructions?: string[] | null;
	uncertainties?: string[] | null;
	corrections?: Record<string, unknown>[] | null;
	turnId?: string | null;
}

export interface ChatReply {
	reply: string;
	memoryUpdates?: ExtractionResult | null;
	turnId?: string | null;
}

export interface ContextResult {
	context: string;
	tier?: string | null;
	queryMs?: number | null;
}

export interface MemoryHit {
	source: string;
	score: number;
	text?: string | null;
	id?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface MemoryQueryResponse {
	hits: MemoryHit[];
	tier?: string | null;
	queryMs?: number | null;
	trace?: Record<string, unknown> | null;
}

export interface StructuredState {
	identity?: Record<string, unknown> | null;
	knowledge?: Record<string, unknown> | null;
	context?: Record<string, unknown> | null;
	instructions?: string[] | null;
	unknowns?: string[] | null;
}

export interface ProfileResponse {
	static?: Record<string, unknown> | null;
	dynamic?: Record<string, unknown> | null;
	preferences?: Record<string, unknown> | null;
	instructions?: string[] | null;
}

export interface Entity {
	type: string;
	name: string;
	attributes?: Record<string, unknown> | null;
	scope?: Record<string, string> | null;
	createdAt?: string | null;
	updatedAt?: string | null;
}

export interface EntityHistoryEntry {
	value: unknown;
	validFrom?: string | null;
	validUntil?: string | null;
	sourceTurn?: string | null;
}

export interface ReflectionResult {
	reflection: string;
	evidence?: Record<string, unknown>[] | null;
	persistedAttributes?: AttributeUpdate[] | null;
}

export interface ForgetResult {
	deleted: number;
}

export interface TraceRecord {
	id: string;
	resolutionTier?: string | null;
	latencyMs?: number | null;
	cached?: boolean | null;
	retrievedCount?: number | null;
	topScores?: number[] | null;
	payload?: Record<string, unknown> | null;
}

export interface TraceListResponse {
	traces: TraceRecord[];
}

export interface TraceStats {
	totalQueries?: number | null;
	cacheHits?: number | null;
	avgLatencyMs?: number | null;
	tierCounts?: Record<string, number> | null;
}
