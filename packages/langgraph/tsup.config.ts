import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		checkpoint: 'src/checkpoint.ts',
		store: 'src/store.ts',
		memory_store: 'src/memory_store.ts',
		cache: 'src/cache.ts',
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
