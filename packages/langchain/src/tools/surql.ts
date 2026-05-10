import {
	SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { StructuredTool, type ToolParams } from '@langchain/core/tools';
import { z } from 'zod';

const READ_ONLY_PREFIX = /^\s*(SELECT|INFO|RETURN|LIVE)\b/i;
const FORBIDDEN_KEYWORDS =
	/\b(CREATE|UPDATE|DELETE|UPSERT|MERGE|INSERT|RELATE|REMOVE|DEFINE|REBUILD|CONTINUE|BREAK|THROW|USE|BEGIN|COMMIT|CANCEL|FOR\s+EACH)\b/i;

interface ClientHolder {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
}

function resolveClient(args: ClientHolder): {
	client: SurrealDBClient;
	owned: boolean;
} {
	if (args.surreal instanceof SurrealDBClient) {
		return { client: args.surreal, owned: false };
	}
	return { client: new SurrealDBClient(args.surreal), owned: true };
}

export interface QueryToolArgs extends ToolParams, ClientHolder {
	name?: string;
	description?: string;
	/**
	 * If true (the default) the tool refuses any query that does not
	 * match a SELECT / INFO / RETURN / LIVE prefix, or whose body
	 * contains a forbidden keyword.
	 */
	readOnly?: boolean;
	/** Soft cap on rows returned to the agent. Default: 50. */
	maxRows?: number;
}

const queryToolSchema = z.object({
	surql: z.string().describe('A SurrealQL statement.'),
	vars: z
		.record(z.any())
		.optional()
		.describe('Optional variable bindings referenced as $name.'),
});

/**
 * Generic SurrealQL tool. The agent can pass any SurrealQL string (and
 * optional variable bindings); by default the tool refuses anything
 * other than read queries.
 *
 * Do not enable `readOnly: false` for tools exposed to untrusted agents
 * — that surface is wide enough to drop tables.
 */
export class QueryTool extends StructuredTool<typeof queryToolSchema> {
	override name: string;
	override description: string;
	override schema = queryToolSchema;

	readonly client: SurrealDBClient;
	readonly readOnly: boolean;
	readonly maxRows: number;
	private readonly ownsClient: boolean;
	private connected = false;

	constructor(args: QueryToolArgs) {
		super(args);
		const { client, owned } = resolveClient(args);
		this.client = client;
		this.ownsClient = owned;
		this.readOnly = args.readOnly ?? true;
		this.maxRows = args.maxRows ?? 50;
		this.name = args.name ?? 'surrealdb_query';
		this.description =
			args.description ??
			'Run a SurrealQL query against the connected SurrealDB ' +
				'instance. Returns the rows as JSON. Read-only by default.';
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	protected override async _call(
		input: z.infer<typeof queryToolSchema>,
		_runManager?: CallbackManagerForToolRun,
	): Promise<string> {
		if (this.readOnly) {
			if (!READ_ONLY_PREFIX.test(input.surql)) {
				throw new Error(
					`QueryTool is read-only — query must start with SELECT, INFO, RETURN or LIVE`,
				);
			}
			if (FORBIDDEN_KEYWORDS.test(input.surql)) {
				throw new Error(
					`QueryTool is read-only — query contains a write keyword`,
				);
			}
		}

		if (!this.connected) {
			await this.client.connect();
			this.connected = true;
		}

		const responses = await this.client.db.query(input.surql, input.vars);
		const flat: unknown[] = [];
		for (const r of responses) {
			if (Array.isArray(r)) flat.push(...r);
			else flat.push(r);
		}
		const trimmed = flat.slice(0, this.maxRows);
		return JSON.stringify(trimmed);
	}
}

export interface RecordToolArgs<S extends z.ZodTypeAny>
	extends ToolParams,
		ClientHolder {
	name: string;
	description: string;
	/** Zod schema for the variable bindings the agent must supply. */
	schema: S;
	/** A SurrealQL template that references the provided variables. */
	surql: string;
	/** Soft cap on rows returned. Default: 50. */
	maxRows?: number;
}

/**
 * A pre-baked SurrealQL tool. Constructor binds a query template plus a
 * Zod schema describing the bindings. The agent never sees the raw query
 * — it only fills in the typed parameters. Lower injection surface than
 * {@link QueryTool}.
 */
export class RecordTool<
	S extends z.ZodTypeAny,
> extends StructuredTool<S> {
	override name: string;
	override description: string;
	override schema: S;

	readonly client: SurrealDBClient;
	readonly surql: string;
	readonly maxRows: number;
	private readonly ownsClient: boolean;
	private connected = false;

	constructor(args: RecordToolArgs<S>) {
		super(args);
		const { client, owned } = resolveClient(args);
		this.client = client;
		this.ownsClient = owned;
		this.name = args.name;
		this.description = args.description;
		this.schema = args.schema;
		this.surql = args.surql;
		this.maxRows = args.maxRows ?? 50;
	}

	async close(): Promise<void> {
		if (this.ownsClient) await this.client.close();
	}

	protected override async _call(
		input: z.infer<S>,
		_runManager?: CallbackManagerForToolRun,
	): Promise<string> {
		if (!this.connected) {
			await this.client.connect();
			this.connected = true;
		}
		const responses = await this.client.db.query(
			this.surql,
			input as Record<string, unknown>,
		);
		const flat: unknown[] = [];
		for (const r of responses) {
			if (Array.isArray(r)) flat.push(...r);
			else flat.push(r);
		}
		return JSON.stringify(flat.slice(0, this.maxRows));
	}
}

export interface CreateToolArgs<S extends z.ZodTypeAny>
	extends ToolParams,
		ClientHolder {
	name: string;
	description: string;
	schema: S;
	handler: (
		client: SurrealDBClient,
		input: z.infer<S>,
	) => Promise<unknown>;
}

/**
 * Convenience factory equivalent to a `DynamicStructuredTool` with the
 * SurrealDB client pre-bound.
 */
export function createTool<S extends z.ZodTypeAny>(
	args: CreateToolArgs<S>,
): StructuredTool<S> {
	const { client, owned } = resolveClient(args);
	let connected = false;

	class InlineTool extends StructuredTool<S> {
		override name = args.name;
		override description = args.description;
		override schema = args.schema;

		async close(): Promise<void> {
			if (owned) await client.close();
		}

		protected override async _call(input: z.infer<S>): Promise<string> {
			if (!connected) {
				await client.connect();
				connected = true;
			}
			const result = await args.handler(client, input);
			return typeof result === 'string'
				? result
				: JSON.stringify(result);
		}
	}

	return new InlineTool(args);
}
