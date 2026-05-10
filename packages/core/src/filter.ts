/**
 * Translate a Mongo-style filter object into a SurrealQL boolean expression
 * plus the bindings to attach to the query. The shape mirrors the filter
 * DSL used by `langchain-community`'s pgvector store so users get a
 * predictable surface.
 *
 * Supported operators (per field):
 *   - { $eq }, { $ne }, { $gt }, { $gte }, { $lt }, { $lte }
 *   - { $in: any[] }, { $nin: any[] }
 *   - { $exists: boolean }
 *
 * A bare value is treated as `$eq`. Multiple top-level keys are AND-ed.
 *
 * The resulting expression references the bindings by `$<prefix>0`,
 * `$<prefix>1`, … so multiple translated filters can be merged into one
 * query without name clashes.
 */

const OPS = {
	$eq: '=',
	$ne: '!=',
	$gt: '>',
	$gte: '>=',
	$lt: '<',
	$lte: '<=',
} as const;

type CmpOp = keyof typeof OPS;

export interface TranslatedFilter {
	expr: string;
	bindings: Record<string, unknown>;
}

export interface TranslateFilterOptions {
	/** Prefix prepended to every generated binding name. Default: "f". */
	bindPrefix?: string;
	/**
	 * Path prefix for every field reference. Use to scope a filter inside a
	 * nested column, e.g. `metadata` becomes `metadata.field = $f0`.
	 */
	fieldPrefix?: string;
}

export function translateFilter(
	filter: Record<string, unknown> | undefined,
	options: TranslateFilterOptions = {},
): TranslatedFilter {
	const bindPrefix = options.bindPrefix ?? 'f';
	const fieldPrefix = options.fieldPrefix ?? '';
	const bindings: Record<string, unknown> = {};
	let counter = 0;

	const fieldRef = (field: string): string =>
		fieldPrefix ? `${fieldPrefix}.${field}` : field;

	const bind = (value: unknown): string => {
		const name = `${bindPrefix}${counter++}`;
		bindings[name] = value;
		return `$${name}`;
	};

	const renderField = (field: string, value: unknown): string => {
		if (value === null) return `${fieldRef(field)} IS NONE`;
		if (typeof value !== 'object' || Array.isArray(value)) {
			return `${fieldRef(field)} = ${bind(value)}`;
		}

		const ops = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const [op, opValue] of Object.entries(ops)) {
			if (op in OPS) {
				parts.push(
					`${fieldRef(field)} ${OPS[op as CmpOp]} ${bind(opValue)}`,
				);
			} else if (op === '$in') {
				assertArray(op, opValue);
				parts.push(`${fieldRef(field)} INSIDE ${bind(opValue)}`);
			} else if (op === '$nin') {
				assertArray(op, opValue);
				parts.push(`${fieldRef(field)} NOT INSIDE ${bind(opValue)}`);
			} else if (op === '$exists') {
				if (typeof opValue !== 'boolean') {
					throw new Error(
						`Filter operator $exists expects a boolean, got ${typeof opValue}`,
					);
				}
				parts.push(
					opValue
						? `${fieldRef(field)} IS NOT NONE`
						: `${fieldRef(field)} IS NONE`,
				);
			} else {
				throw new Error(`Unsupported filter operator: ${op}`);
			}
		}
		return parts.length === 1
			? (parts[0] as string)
			: `(${parts.join(' AND ')})`;
	};

	if (!filter || Object.keys(filter).length === 0) {
		return { expr: '', bindings };
	}

	const fragments: string[] = [];
	for (const [field, value] of Object.entries(filter)) {
		fragments.push(renderField(field, value));
	}
	const expr =
		fragments.length === 1
			? (fragments[0] as string)
			: fragments.join(' AND ');
	return { expr, bindings };
}

function assertArray(op: string, value: unknown): asserts value is unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`Filter operator ${op} expects an array`);
	}
}
