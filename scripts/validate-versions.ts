#!/usr/bin/env bun
/**
 * Verify that a release tag matches the version field in every published
 * package. Called from the publish workflow before any npm publish runs.
 *
 * Usage: bun run scripts/validate-versions.ts <tag>
 *   tag may be `v0.1.0` or `0.1.0` — the leading `v` is stripped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGES = ['core', 'langchain', 'langgraph'];

const arg = process.argv[2];
if (!arg) {
	console.error('usage: validate-versions.ts <tag>');
	process.exit(1);
}
const expected = arg.replace(/^v/, '');

const failures: string[] = [];
for (const pkg of PACKAGES) {
	const path = resolve(import.meta.dir, '..', 'packages', pkg, 'package.json');
	const json = JSON.parse(readFileSync(path, 'utf8')) as {
		name: string;
		version: string;
	};
	if (json.version !== expected) {
		failures.push(
			`  ${json.name}: package.json says "${json.version}", tag says "${expected}"`,
		);
	} else {
		console.log(`✓ ${json.name}@${json.version}`);
	}
}

if (failures.length > 0) {
	console.error(`\nVersion mismatch:\n${failures.join('\n')}`);
	process.exit(1);
}
console.log(`\nAll packages match tag v${expected}`);
