import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		checkpoint: 'src/checkpoint.ts',
		store: 'src/store.ts',
		spectron_store: 'src/spectron_store.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	splitting: false,
	external: [
		'@langchain/core',
		'@langchain/langgraph-checkpoint',
		'@surrealdb/langchain-core',
		'surrealdb',
	],
});
