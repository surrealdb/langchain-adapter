import { SurrealDBClient } from '@surrealdb/langchain-core';

export interface RecordedQuery {
	surql: string;
	bindings?: Record<string, unknown>;
}

/**
 * A `SurrealDBClient` that talks to nothing.
 *
 * Subclasses rather than mocks so `args.surreal instanceof SurrealDBClient`
 * still holds in every adapter, and records each `(surql, bindings)` pair so
 * tests can assert on the SurrealQL actually emitted.
 */
export class FakeSurrealDBClient extends SurrealDBClient {
	readonly queries: RecordedQuery[] = [];
	/** Rows returned by the next `queryAll` calls, in order. */
	rows: unknown[][] = [];

	constructor() {
		super({
			url: 'ws://localhost:8000',
			username: 'root',
			password: 'root',
		});
	}

	override async connect(): Promise<void> {}
	override async close(): Promise<void> {}
	override async assertServerVersion(): Promise<void> {}

	override async queryAll<T>(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<T[]> {
		this.queries.push({ surql, bindings });
		return (this.rows.shift() ?? []) as T[];
	}

	/** Statement-level results, for `RETURN`-style scalar queries. */
	override async queryMany<T extends unknown[]>(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		this.queries.push({ surql, bindings });
		return (this.rows.shift() ?? []) as T;
	}

	override async execute(
		surql: string,
		bindings?: Record<string, unknown>,
	): Promise<void> {
		this.queries.push({ surql, bindings });
	}

	/**
	 * Runs `fn` against a stand-in transaction handle that records into the
	 * same log. Enough for asserting on emitted SurrealQL; it does not model
	 * rollback.
	 */
	override async tx<T>(fn: (tx: never) => Promise<T>): Promise<T> {
		const self = this;
		const handle = {
			query(surql: string, bindings?: Record<string, unknown>) {
				self.queries.push({ surql, bindings });
				const rows = self.rows.shift() ?? [];
				// `collect()` yields one entry per statement, and the entry is
				// that statement's row array — same as the real driver.
				return { collect: async () => [rows] };
			},
			commit: async () => {},
			cancel: async () => {},
		};
		return fn(handle as never);
	}

	/** The single query emitted, asserting there was exactly one. */
	only(): RecordedQuery {
		if (this.queries.length !== 1) {
			throw new Error(
				`expected exactly 1 query, got ${this.queries.length}:\n` +
					this.queries.map((q) => q.surql).join('\n'),
			);
		}
		return this.queries[0] as RecordedQuery;
	}

	last(): RecordedQuery {
		const q = this.queries.at(-1);
		if (!q) throw new Error('no queries recorded');
		return q;
	}
}
