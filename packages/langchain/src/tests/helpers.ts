import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import {
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';

const DEFAULT_URL = process.env.SURREALDB_URL ?? 'ws://localhost:8000';
const DEFAULT_USER = process.env.SURREALDB_USER ?? 'root';
const DEFAULT_PASS = process.env.SURREALDB_PASS ?? 'root';

export function makeConfig(
	suffix: string,
): SurrealDBStoreConfig & { namespace: string; database: string } {
	return {
		url: DEFAULT_URL,
		username: DEFAULT_USER,
		password: DEFAULT_PASS,
		namespace: 'langchain_test',
		database: `${suffix}_${Date.now()}`,
	};
}

export async function freshClient(suffix: string): Promise<SurrealDBClient> {
	const c = new SurrealDBClient(makeConfig(suffix));
	await c.connect();
	return c;
}

/**
 * Deterministic toy embedder for tests — turns each character into a slot
 * in a fixed-width vector. Cosine distance approximates simple character
 * overlap.
 */
export class FakeEmbeddings implements EmbeddingsInterface {
	constructor(public dims = 16) {}

	async embedDocuments(texts: string[]): Promise<number[][]> {
		return texts.map((t) => this.embed(t));
	}

	async embedQuery(text: string): Promise<number[]> {
		return this.embed(text);
	}

	private embed(text: string): number[] {
		const v = new Array<number>(this.dims).fill(0);
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			v[code % this.dims] = (v[code % this.dims] ?? 0) + 1;
		}
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
		return v.map((x) => x / norm);
	}
}
