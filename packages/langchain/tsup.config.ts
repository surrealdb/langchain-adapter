import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		vectorstores: 'src/vectorstores/index.ts',
		retrievers: 'src/retrievers/index.ts',
		tools: 'src/tools/index.ts',
		chat_models: 'src/chat_models/index.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	splitting: false,
	external: [
		'@langchain/core',
		'@surrealdb/langchain-core',
		'surrealdb',
		'zod',
	],
});
