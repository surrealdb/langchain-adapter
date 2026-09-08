/**
 * Small helpers that produce SurrealQL DDL fragments. They exist so the
 * vector store, checkpointer and store can share a single source of truth
 * for their `DEFINE TABLE / FIELD / INDEX` statements.
 */

export type DistanceStrategy = 'cosine' | 'euclidean' | 'manhattan' | 'hamming';

/**
 * SurrealDB v3 dropped `MTREE` — `DEFINE INDEX … MTREE` is a parse error on
 * 3.2 — so the choices are the two graph indexes or none at all.
 * `diskann` requires SurrealDB ≥ 3.1.
 */
export type VectorIndexType = 'hnsw' | 'diskann' | 'none';

export interface DefineVectorIndexOptions {
	tableName: string;
	indexName: string;
	field: string;
	dimensions: number;
	distance: DistanceStrategy;
	type: VectorIndexType;
	hnsw?: { m?: number; efc?: number };
	diskann?: { buildList?: number };
}

const DIST_TOKEN: Record<DistanceStrategy, string> = {
	cosine: 'COSINE',
	euclidean: 'EUCLIDEAN',
	manhattan: 'MANHATTAN',
	hamming: 'HAMMING',
};

export function defineVectorIndex(opts: DefineVectorIndexOptions): string {
	if (opts.type === 'none') return '';
	const head =
		`DEFINE INDEX IF NOT EXISTS ${opts.indexName} ON ${opts.tableName} ` +
		`FIELDS ${opts.field}`;
	if (opts.type === 'diskann') {
		const buildList = opts.diskann?.buildList;
		return (
			`${head} DISKANN DIMENSION ${opts.dimensions} ` +
			`DIST ${DIST_TOKEN[opts.distance]}` +
			(buildList === undefined ? '' : ` BUILD_LIST ${buildList}`)
		);
	}
	const m = opts.hnsw?.m ?? 12;
	const efc = opts.hnsw?.efc ?? 100;
	return (
		`${head} HNSW DIMENSION ${opts.dimensions} ` +
		`DIST ${DIST_TOKEN[opts.distance]} M ${m} EFC ${efc}`
	);
}

/**
 * Builds an idempotent `DEFINE TABLE` + `DEFINE FIELD` block for a record
 * shape used by the adapters. The caller passes the field definitions as
 * raw fragments (everything after `DEFINE FIELD <name> ON <table>`).
 */
export function defineTable(
	tableName: string,
	fields: Array<{ name: string; type: string }>,
): string {
	const lines: string[] = [
		`DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMAFULL;`,
	];
	for (const f of fields) {
		lines.push(
			`DEFINE FIELD IF NOT EXISTS ${f.name} ON ${tableName} ${f.type};`,
		);
	}
	return lines.join('\n');
}

/**
 * Validate a SurrealQL identifier (table, field, index name). We allow
 * simple snake_case identifiers because every table/field name we accept
 * from user config is interpolated directly into a DDL string.
 */
export function assertIdent(name: string, role = 'identifier'): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`Invalid SurrealDB ${role}: ${JSON.stringify(name)}. ` +
				`Use only letters, digits and underscores; first char must be a letter or underscore.`,
		);
	}
	return name;
}

/**
 * Validate a value destined for an interpolated `LIMIT` / `START` / `k`.
 *
 * These cannot be bound as parameters portably — parameterised `LIMIT`
 * support varies across server versions — so they are interpolated, and the
 * only safe interpolation is one that is provably an integer.
 */
export function assertCount(value: number, role = 'limit'): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`Invalid SurrealDB ${role}: ${JSON.stringify(value)}. ` +
				`Expected a non-negative safe integer.`,
		);
	}
	return value;
}

/**
 * Drop `null` / `undefined` entries from a row before writing it.
 *
 * SurrealDB's `option<T>` accepts the field being absent (or `NONE`) but
 * *rejects* `NULL`: "Couldn't coerce value for field `x`: Expected
 * `none | string` but found `NULL`". A JS `null` marshals to `NULL`, so an
 * optional column has to be omitted rather than nulled.
 */
export function compactRow<T extends Record<string, unknown>>(
	row: T,
): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (value !== null && value !== undefined) out[key] = value;
	}
	return out as Partial<T>;
}
