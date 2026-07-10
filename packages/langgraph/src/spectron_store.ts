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
	resolveSpectron,
	type Spectron,
	type SpectronClientConfig,
} from '@surrealdb/langchain-core';

export interface SpectronStoreArgs {
	spectron: SpectronClientConfig;
	namespaceSeparator?: string;
}

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

// Read-only: Spectron writes flow through session turns and reflections, not
// a flat K/V API, so put/delete/listNamespaces throw.
export class SpectronStore extends BaseLangGraphStore {
	readonly client: Spectron;
	readonly namespaceSeparator: string;

	constructor(args: SpectronStoreArgs) {
		super();
		this.client = resolveSpectron(args.spectron);
		this.namespaceSeparator = args.namespaceSeparator ?? '/';
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
		const results: unknown[] = new Array(operations.length);
		await Promise.all(
			operations.map(async (op, idx) => {
				if (isPut(op)) {
					throw new Error(
						'SpectronStore does not support put/delete: Spectron memory is written via session turns or reflections, not raw key/value writes. Use Spectron.sessions / .reflect directly.',
					);
				}
				if (isListNamespaces(op)) {
					throw new Error(
						'SpectronStore does not support listNamespaces: Spectron does not expose namespace enumeration.',
					);
				}
				if (isGet(op)) {
					results[idx] = await this.handleGet(op);
					return;
				}
				if (isSearch(op)) {
					results[idx] = await this.handleSearch(op);
					return;
				}
				throw new Error(
					'Unknown operation passed to SpectronStore.batch',
				);
			}),
		);
		return results as OperationResults<Op>;
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
				'SpectronStore.search requires a `query` string — Spectron only supports semantic queries via Spectron.query.',
			);
		}
		const response = await this.client.recall(op.query, {
			k: op.limit,
		});
		const namespace = op.namespacePrefix;
		const now = new Date(0);
		return response.hits.map((hit) => ({
			namespace,
			key: hit.id ?? hit.source,
			value: {
				text: hit.text ?? '',
				source: hit.source,
			},
			createdAt: now,
			updatedAt: now,
			score: hit.score,
		}));
	}
}
