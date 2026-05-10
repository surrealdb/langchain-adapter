/**
 * Small helpers that produce SurrealQL DDL fragments. They exist so the
 * vector store, checkpointer and store can share a single source of truth
 * for their `DEFINE TABLE / FIELD / INDEX` statements.
 */

export type DistanceStrategy =
	| 'cosine'
	| 'euclidean'
	| 'manhattan'
	| 'hamming';

export type VectorIndexType = 'hnsw' | 'mtree' | 'none';

export interface DefineVectorIndexOptions {
	tableName: string;
	indexName: string;
	field: string;
	dimensions: number;
	distance: DistanceStrategy;
	type: VectorIndexType;
	hnsw?: { m?: number; efc?: number };
	mtree?: { capacity?: number };
}

const DIST_TOKEN: Record<DistanceStrategy, string> = {
	cosine: 'COSINE',
	euclidean: 'EUCLIDEAN',
	manhattan: 'MANHATTAN',
	hamming: 'HAMMING',
};

export function defineVectorIndex(opts: DefineVectorIndexOptions): string {
	if (opts.type === 'none') return '';
	if (opts.type === 'hnsw') {
		const m = opts.hnsw?.m ?? 12;
		const efc = opts.hnsw?.efc ?? 100;
		return (
			`DEFINE INDEX IF NOT EXISTS ${opts.indexName} ON ${opts.tableName} ` +
			`FIELDS ${opts.field} HNSW DIMENSION ${opts.dimensions} ` +
			`DIST ${DIST_TOKEN[opts.distance]} M ${m} EFC ${efc}`
		);
	}
	const capacity = opts.mtree?.capacity ?? 40;
	return (
		`DEFINE INDEX IF NOT EXISTS ${opts.indexName} ON ${opts.tableName} ` +
		`FIELDS ${opts.field} MTREE DIMENSION ${opts.dimensions} ` +
		`DIST ${DIST_TOKEN[opts.distance]} CAPACITY ${capacity}`
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
