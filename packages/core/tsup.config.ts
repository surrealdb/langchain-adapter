import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		spectron: 'src/spectron/index.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	splitting: false,
	external: ['surrealdb'],
});
