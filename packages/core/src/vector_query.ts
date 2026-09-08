import type { DistanceStrategy, VectorIndexType } from './schema.js';

const DIST_TOKEN: Record<DistanceStrategy, string> = {
	cosine: 'COSINE',
	euclidean: 'EUCLIDEAN',
	manhattan: 'MANHATTAN',
	hamming: 'HAMMING',
};

export interface VectorQueryOptions {
	field: string;
	k: number;
	distance: DistanceStrategy;
	/** The index actually defined on `field`, if any. */
	indexType: VectorIndexType;
	/** Search breadth for the graph indexes. Default 40. */
	ef?: number;
	/** Name of the bound parameter holding the query vector. Default `vec`. */
	param?: string;
}

/**
 * The KNN predicate for a vector search, plus the expression that reads the
 * resulting distance back out.
 *
 * There is exactly one correct spelling per situation, and getting it wrong
 * fails in three different ways on SurrealDB 3.x — hence one builder shared
 * by every call site:
 *
 * - `<|k|>` (the old MTREE form) is **rejected outright**: "The `<|k|>` KNN
 *   operator (KTree / M-Tree) is no longer supported."
 * - `<|k,EF|>` needs a graph index on the field. Against an unindexed field
 *   it returns wrong results *silently* rather than erroring.
 * - `<|k,METRIC|>` is the brute-force form, and the only correct one when
 *   there is no index.
 *
 * An extra `WHERE` alongside the operator is fine, and better than fine: with
 * an HNSW or DISKANN index the predicate is pushed into the graph traversal
 * (`EXPLAIN` shows it as `predicate` on `KnnScan`), so non-matching rows are
 * rejected before they take up one of the `k` slots.
 */
export function knnPredicate(opts: VectorQueryOptions): {
	predicate: string;
	distanceExpr: string;
} {
	const param = opts.param ?? 'vec';
	const arg =
		opts.indexType === 'none'
			? DIST_TOKEN[opts.distance]
			: String(opts.ef ?? 40);
	return {
		predicate: `${opts.field} <|${opts.k},${arg}|> $${param}`,
		distanceExpr: 'vector::distance::knn()',
	};
}

/**
 * A plain distance expression, for ordering without the KNN operator.
 *
 * Needed wherever a query cannot use `<|…|>` — SurrealDB allows only one KNN
 * operator per query.
 */
export function explicitDistance(
	strategy: DistanceStrategy,
	field: string,
	param = 'vec',
): string {
	switch (strategy) {
		case 'cosine':
			return `(1.0 - vector::similarity::cosine(${field}, $${param}))`;
		case 'euclidean':
			return `vector::distance::euclidean(${field}, $${param})`;
		case 'manhattan':
			return `vector::distance::manhattan(${field}, $${param})`;
		case 'hamming':
			return `vector::distance::hamming(${field}, $${param})`;
	}
}
