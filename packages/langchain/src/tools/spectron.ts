import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { StructuredTool, type ToolParams } from '@langchain/core/tools';
import { Spectron, type SpectronConfig } from '@surrealdb/langchain-core';
import { z } from 'zod';

interface ClientHolder {
	client: Spectron | SpectronConfig;
}

function resolveClient(args: ClientHolder): Spectron {
	return args.client instanceof Spectron ? args.client : new Spectron(args.client);
}

const queryToolSchema = z.object({
	query: z
		.string()
		.describe('Natural-language query for Spectron knowledge.'),
	k: z.number().int().positive().optional().describe('Max number of hits.'),
	mode: z
		.enum(['vector', 'bm25', 'hybrid', 'hybrid_graph'])
		.optional()
		.describe('Retrieval mode. Default: hybrid.'),
	filter: z
		.record(z.any())
		.optional()
		.describe(
			'Optional metadata filter, e.g. {"mimeType": ["application/pdf"]}.',
		),
});

export interface SpectronQueryToolArgs extends ToolParams, ClientHolder {
	name?: string;
	description?: string;
	defaultK?: number;
}

export class SpectronQueryTool extends StructuredTool<typeof queryToolSchema> {
	override name: string;
	override description: string;
	override schema = queryToolSchema;
	readonly client: Spectron;
	private readonly defaultK: number;

	constructor(args: SpectronQueryToolArgs) {
		super(args);
		this.client = resolveClient(args);
		this.defaultK = args.defaultK ?? 10;
		this.name = args.name ?? 'spectron_query';
		this.description =
			args.description ??
			'Search the Spectron knowledge base. Pass a natural-language query and ' +
				'optionally k, mode, or a metadata filter. Returns the top hits.';
	}

	protected override async _call(
		input: z.infer<typeof queryToolSchema>,
		_runManager?: CallbackManagerForToolRun,
	): Promise<string> {
		const response = await this.client.knowledge.query({
			query: input.query,
			mode: input.mode,
			k: input.k ?? this.defaultK,
			filter: input.filter,
		});
		const compact = response.results.map((hit) => ({
			text: hit.chunk.text,
			score: hit.score,
			documentId: hit.document.id,
			title: hit.document.title,
			source: hit.document.source,
		}));
		return JSON.stringify(compact);
	}
}

const reflectToolSchema = z.object({
	query: z
		.string()
		.describe(
			'What to reflect on, e.g. "patterns in customer complaints".',
		),
	persist: z
		.boolean()
		.optional()
		.describe('When true, persist the reflection as durable memory.'),
});

export interface SpectronReflectToolArgs extends ToolParams, ClientHolder {
	name?: string;
	description?: string;
}

export class SpectronReflectTool extends StructuredTool<
	typeof reflectToolSchema
> {
	override name: string;
	override description: string;
	override schema = reflectToolSchema;
	readonly client: Spectron;

	constructor(args: SpectronReflectToolArgs) {
		super(args);
		this.client = resolveClient(args);
		this.name = args.name ?? 'spectron_reflect';
		this.description =
			args.description ??
			'Ask Spectron to reflect over its memory of a question. Returns the ' +
				'reflection text. Pass persist=true to durably store it.';
	}

	protected override async _call(
		input: z.infer<typeof reflectToolSchema>,
		_runManager?: CallbackManagerForToolRun,
	): Promise<string> {
		const result = await this.client.reflect({
			query: input.query,
			persist: input.persist,
		});
		return JSON.stringify(result);
	}
}
