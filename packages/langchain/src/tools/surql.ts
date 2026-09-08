import { tool } from '@langchain/core/tools';
import {
	assertCount,
	resolveClient,
	type SurrealDBClient,
	type SurrealDBStoreConfig,
} from '@surrealdb/langchain-core';
import { z } from 'zod';

const READ_ONLY_PREFIX = /^\s*(SELECT|INFO|RETURN)\b/i;
const FORBIDDEN_KEYWORDS =
	/\b(CREATE|UPDATE|DELETE|UPSERT|MERGE|INSERT|RELATE|REMOVE|DEFINE|ALTER|REBUILD|KILL|LIVE|LET|SLEEP|CONTINUE|BREAK|THROW|USE|BEGIN|COMMIT|CANCEL)\b/i;
const CUSTOM_FUNCTION = /\bfn::/i;

interface ClientHolder {
	surreal: SurrealDBClient | SurrealDBStoreConfig;
}

/** What a SurrealQL tool hands back as its artifact. */
export interface SurrealQLToolArtifact {
	rows: unknown[];
	rowCount: number;
	truncated: boolean;
}

/**
 * Guard against obviously-destructive statements in `readOnly` mode.
 *
 * This is a guard-rail, not a security boundary — a regex cannot be one.
 * Anything reachable by an untrusted agent should be behind a SurrealDB user
 * with read-only permissions or record-level access; this only catches the
 * accidental case early, with a clearer message.
 */
function assertReadOnly(surql: string): void {
	if (!READ_ONLY_PREFIX.test(surql)) {
		throw new Error(
			'This tool is read-only — the query must start with SELECT, INFO or RETURN.',
		);
	}
	if (surql.includes(';')) {
		// A `;` allows a second statement to ride along behind a valid SELECT.
		throw new Error(
			'This tool is read-only — the query must be a single statement (no ";").',
		);
	}
	if (FORBIDDEN_KEYWORDS.test(surql)) {
		throw new Error(
			'This tool is read-only — the query contains a write, DDL or control keyword.',
		);
	}
	if (CUSTOM_FUNCTION.test(surql)) {
		throw new Error(
			'This tool is read-only — custom `fn::` functions are not allowed, since their body is not visible here.',
		);
	}
}

/** Flatten SurrealDB's per-statement responses into one row list. */
function flattenRows(responses: unknown[], maxRows: number) {
	const flat: unknown[] = [];
	for (const r of responses) {
		if (Array.isArray(r)) flat.push(...r);
		else flat.push(r);
	}
	const rows = flat.slice(0, maxRows);
	return {
		rows,
		rowCount: flat.length,
		truncated: flat.length > rows.length,
	} satisfies SurrealQLToolArtifact;
}

/** Model-facing summary. The full rows travel as the artifact. */
function summarise(artifact: SurrealQLToolArtifact): string {
	if (artifact.rowCount === 0) return 'No rows.';
	const suffix = artifact.truncated
		? ` (showing ${artifact.rows.length} of ${artifact.rowCount})`
		: '';
	return `${artifact.rowCount} row(s)${suffix}:\n${JSON.stringify(artifact.rows)}`;
}

/** Connect once, without racing two concurrent first calls. */
function connector(client: SurrealDBClient): () => Promise<void> {
	let pending: Promise<void> | undefined;
	return () => {
		pending ??= client.connect();
		return pending;
	};
}

export interface QueryToolArgs extends ClientHolder {
	name?: string;
	description?: string;
	/**
	 * Refuse anything that is not a single read statement. Default `true`.
	 * See {@link assertReadOnly} — this is a guard-rail, not a sandbox.
	 */
	readOnly?: boolean;
	/** Soft cap on rows returned to the agent. Default: 50. */
	maxRows?: number;
}

const queryToolSchema = z.object({
	surql: z.string().describe('A SurrealQL statement.'),
	vars: z
		.record(z.string(), z.any())
		.optional()
		.describe('Optional variable bindings referenced as $name.'),
});

/**
 * Generic SurrealQL tool: the agent supplies the statement and bindings.
 *
 * Returns a compact summary as the model-visible content and the full rows as
 * the artifact, so a caller can use the real data without re-parsing a string.
 */
export function createQueryTool(args: QueryToolArgs) {
	const { client } = resolveClient(args.surreal);
	const connect = connector(client);
	const readOnly = args.readOnly ?? true;
	const maxRows = assertCount(args.maxRows ?? 50, 'maxRows');

	return tool(
		async (input) => {
			if (readOnly) assertReadOnly(input.surql);
			await connect();
			const responses = await client.db.query(input.surql, input.vars);
			const artifact = flattenRows(responses, maxRows);
			return [summarise(artifact), artifact];
		},
		{
			name: args.name ?? 'surrealdb_query',
			description:
				args.description ??
				'Run a SurrealQL query against the connected SurrealDB instance. ' +
					'Read-only by default.',
			schema: queryToolSchema,
			responseFormat: 'content_and_artifact',
		},
	);
}

export interface RecordToolArgs<S extends z.ZodObject<z.ZodRawShape>> extends ClientHolder {
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
 * A pre-baked SurrealQL tool: the query is fixed at construction and the agent
 * only fills in typed parameters, so it never composes SurrealQL itself.
 * Much the smaller attack surface — prefer this over {@link createQueryTool}.
 */
export function createRecordTool<S extends z.ZodObject<z.ZodRawShape>>(
	args: RecordToolArgs<S>,
) {
	const { client } = resolveClient(args.surreal);
	const connect = connector(client);
	const maxRows = assertCount(args.maxRows ?? 50, 'maxRows');

	return tool(
		async (input: z.infer<S>) => {
			await connect();
			const responses = await client.db.query(
				args.surql,
				input as Record<string, unknown>,
			);
			const artifact = flattenRows(responses, maxRows);
			return [summarise(artifact), artifact];
		},
		{
			name: args.name,
			description: args.description,
			schema: args.schema,
			responseFormat: 'content_and_artifact',
		},
	);
}

export interface CreateToolArgs<S extends z.ZodObject<z.ZodRawShape>> extends ClientHolder {
	name: string;
	description: string;
	schema: S;
	handler: (client: SurrealDBClient, input: z.infer<S>) => Promise<unknown>;
}

/**
 * Build a tool around your own handler, with the SurrealDB client pre-bound
 * and connected on first use.
 */
export function createTool<S extends z.ZodObject<z.ZodRawShape>>(
	args: CreateToolArgs<S>,
) {
	const { client } = resolveClient(args.surreal);
	const connect = connector(client);

	return tool(
		async (input: z.infer<S>) => {
			await connect();
			const result = await args.handler(client, input);
			const content =
				typeof result === 'string' ? result : JSON.stringify(result);
			return [content, result];
		},
		{
			name: args.name,
			description: args.description,
			schema: args.schema,
			responseFormat: 'content_and_artifact',
		},
	);
}
