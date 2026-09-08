import {
	BaseStore as BaseLangGraphStore,
	type GetOperation,
	type Item,
	type ListNamespacesOperation,
	type Operation,
	type OperationResults,
	type PutOperation,
	type SearchItem,
	type SearchOperation,
} from '@langchain/langgraph-checkpoint';
import {
	AgentMemoryNotFoundError,
	resolveAgentMemory,
	type AgentMemory,
	type AgentMemoryClientConfig,
} from '@surrealdb/langchain-core';

/**
 * How `search` should treat a non-empty `namespacePrefix`.
 *
 * Agent Memory's recall has no namespace dimension, so a prefix cannot simply
 * be honoured:
 *
 * - `'error'` (default) — reject it, rather than return unscoped hits.
 * - `'ignore'` — search everything and report `namespace: []`, so results are
 *   never labelled with a scope that was not applied.
 * - `'lens'` — pass the prefix as a scope `lens`, a real server-side
 *   narrowing, after which echoing the prefix back is accurate.
 */
export type AgentMemoryNamespaceMode = 'error' | 'ignore' | 'lens';

export interface AgentMemoryStoreArgs {
	client: AgentMemoryClientConfig;
	namespaceSeparator?: string;
	/** Default `'error'`. See {@link AgentMemoryNamespaceMode}. */
	namespaceMode?: AgentMemoryNamespaceMode;
}

/**
 * `MemoryHitJson` carries no timestamps, so search results have none to
 * report. A sentinel is at least honest; `new Date()` would invent a value
 * that looks meaningful.
 */
const UNKNOWN_TIME = new Date(0);

function isGet(op: Operation): op is GetOperation {
	return 'key' in op && !('value' in op);
}
function isPut(op: Operation): op is PutOperation {
	return 'key' in op && 'value' in op;
}
function isSearch(op: Operation): op is SearchOperation {
	return 'namespacePrefix' in op;
}
function isListNamespaces(op: Operation): op is ListNamespacesOperation {
	return 'limit' in op && 'offset' in op && !('namespacePrefix' in op);
}

function parseDate(v: string | null | undefined): Date {
	if (!v) return new Date(0);
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

// Read-only: Agent Memory writes flow through session turns and reflections, not
// a flat K/V API, so put/delete/listNamespaces throw.
export class AgentMemoryStore extends BaseLangGraphStore {
	readonly client: AgentMemory;
	readonly namespaceSeparator: string;
	readonly namespaceMode: AgentMemoryNamespaceMode;

	constructor(args: AgentMemoryStoreArgs) {
		super();
		this.client = resolveAgentMemory(args.client);
		this.namespaceSeparator = args.namespaceSeparator ?? '/';
		this.namespaceMode = args.namespaceMode ?? 'error';
	}

	private toEntityType(namespace: string[]): string {
		return namespace.join(this.namespaceSeparator);
	}

	private fromEntityType(type: string): string[] {
		if (!type) return [];
		return type.split(this.namespaceSeparator);
	}

	override async batch<Op extends Operation[]>(
		operations: Op,
	): Promise<OperationResults<Op>> {
		// A lone operation is the direct-call path (`BaseStore.put` awaits
		// `batch([op])` and discards the result), so a failure has to throw or
		// it would be swallowed.
		if (operations.length === 1) {
			return [
				await this.runOne(operations[0] as Operation),
			] as OperationResults<Op>;
		}

		// For a real batch, isolate failures per slot instead of rejecting
		// everything. `AsyncBatchedStore` coalesces concurrent calls into one
		// batch and resolves each caller from its own slot, so one unsupported
		// `put` would otherwise take unrelated concurrent reads down with it —
		// and mixed batches are the normal case, not the exception.
		const settled = await Promise.allSettled(
			operations.map((op) => this.runOne(op)),
		);
		return settled.map((r) => {
			if (r.status === 'fulfilled') return r.value;
			// A rejected promise in the slot: the awaiting caller adopts it,
			// nobody else does. The extra `.catch` keeps Node from reporting
			// it as unhandled if a direct `batch()` caller ignores the slot.
			const rejected = Promise.reject(r.reason);
			rejected.catch(() => {});
			return rejected;
		}) as OperationResults<Op>;
	}

	private async runOne(op: Operation): Promise<unknown> {
		if (isPut(op)) {
			throw new Error(
				'AgentMemoryStore does not support put/delete: Agent Memory is written via session turns or reflections, not raw key/value writes. Use AgentMemory.sessions / .reflect directly.',
			);
		}
		if (isListNamespaces(op)) {
			throw new Error(
				'AgentMemoryStore does not support listNamespaces: Agent Memory does not expose namespace enumeration.',
			);
		}
		if (isGet(op)) return this.handleGet(op);
		if (isSearch(op)) return this.handleSearch(op);
		throw new Error('Unknown operation passed to AgentMemoryStore.batch');
	}

	private async handleGet(op: GetOperation): Promise<Item | null> {
		const type = this.toEntityType(op.namespace);
		try {
			const resp = await this.client.entities.get(type, op.key);
			const value = Object.fromEntries(
				resp.attributes.map((attr) => [attr.key, attr.value]),
			);
			return {
				namespace: this.fromEntityType(resp.entity.entityType),
				key: resp.entity.name,
				value,
				createdAt: parseDate(resp.entity.createdAt),
				updatedAt: parseDate(resp.entity.updatedAt),
			};
		} catch (err) {
			if (err instanceof AgentMemoryNotFoundError) return null;
			// Duck-typed fallback, in case a differently-resolved copy of the
			// SDK produced the error.
			if (
				err &&
				typeof err === 'object' &&
				'status' in err &&
				(err as { status: number }).status === 404
			) {
				return null;
			}
			throw err;
		}
	}

	private async handleSearch(op: SearchOperation): Promise<SearchItem[]> {
		if (!op.query) {
			throw new Error(
				'AgentMemoryStore.search requires a `query` string — Agent Memory only supports semantic queries via AgentMemory.recall.',
			);
		}

		const prefix = op.namespacePrefix ?? [];
		let lens: string[][] | undefined;
		if (prefix.length > 0) {
			if (this.namespaceMode === 'error') {
				throw new Error(
					`AgentMemoryStore.search cannot scope to namespace ` +
						`[${prefix.join(', ')}]: Agent Memory recall has no ` +
						`namespace dimension. Pass [] to search everything, or ` +
						`set namespaceMode: 'lens' to map the namespace onto a ` +
						`scope lens (or 'ignore' to search unscoped).`,
				);
			}
			if (this.namespaceMode === 'lens') {
				lens = [[prefix.join(this.namespaceSeparator)]];
			}
		}

		// Filters become label constraints; labels are AND-ed, which matches
		// filter semantics. Operator objects have no equivalent.
		const labels: string[] = [];
		for (const [key, value] of Object.entries(op.filter ?? {})) {
			if (
				value !== null &&
				(typeof value === 'object' || Array.isArray(value))
			) {
				throw new Error(
					`AgentMemoryStore.search cannot apply the operator filter ` +
						`on ${JSON.stringify(key)}: Agent Memory supports only ` +
						`exact key=value label matches.`,
				);
			}
			labels.push(`${key}=${String(value)}`);
		}

		// recall() has no offset, so over-fetch and slice.
		const offset = op.offset ?? 0;
		const limit = op.limit ?? 10;
		const response = await this.client.recall(op.query, {
			k: limit + offset,
			...(labels.length > 0 ? { labels } : {}),
			...(lens ? { lens } : {}),
		});

		// Only echo the prefix back when it was genuinely applied.
		const namespace = lens ? prefix : [];
		return response.hits.slice(offset, offset + limit).map((hit) => ({
			namespace,
			key: hit.id ?? hit.source,
			value: {
				text: hit.text ?? '',
				source: hit.source,
			},
			createdAt: UNKNOWN_TIME,
			updatedAt: UNKNOWN_TIME,
			score: hit.score,
		}));
	}
}
