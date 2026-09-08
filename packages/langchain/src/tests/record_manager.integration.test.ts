import { Document } from '@langchain/core/documents';
import { index } from '@langchain/core/indexing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealDBRecordManager } from '../indexes/record_manager.js';
import { SurrealDBVectorStore } from '../vectorstores/surrealdb.js';
import { FakeEmbeddings, makeConfig } from './helpers.js';

/**
 * The LangChain indexing API end-to-end.
 *
 * This is the acceptance test for the record-id contract: `index()` mints
 * UUIDv5 keys, hands them to `addDocuments({ ids })`, and later passes them
 * back to `delete({ ids })`. Any asymmetry between what the store writes and
 * what it accepts shows up here as a wrong count.
 */
describe('SurrealDBRecordManager + index()', () => {
	const config = makeConfig('recman');
	let recordManager: SurrealDBRecordManager;
	let vectorStore: SurrealDBVectorStore;

	beforeAll(async () => {
		recordManager = await SurrealDBRecordManager.initialize({
			surreal: config,
			namespace: 'test',
		});
		vectorStore = await SurrealDBVectorStore.initialize(
			new FakeEmbeddings(16),
			{ surreal: config, dimensions: 16, tableName: 'indexed_docs' },
		);
	});

	afterAll(async () => {
		await recordManager?.close();
		await vectorStore?.close();
	});

	const docs = (texts: string[], source = 's1') =>
		texts.map(
			(t) => new Document({ pageContent: t, metadata: { source } }),
		);

	it('adds new documents on the first run', async () => {
		const result = await index({
			docsSource: docs(['alpha', 'beta']),
			recordManager,
			vectorStore,
			options: {
				cleanup: 'incremental',
				sourceIdKey: 'source',
			},
		});
		expect(result).toMatchObject({ numAdded: 2, numSkipped: 0 });
	});

	it('skips unchanged documents on a second run', async () => {
		const result = await index({
			docsSource: docs(['alpha', 'beta']),
			recordManager,
			vectorStore,
			options: {
				cleanup: 'incremental',
				sourceIdKey: 'source',
			},
		});
		expect(result).toMatchObject({ numAdded: 0, numSkipped: 2 });
	});

	it('adds the new and deletes the removed when the source changes', async () => {
		const result = await index({
			docsSource: docs(['alpha', 'gamma']),
			recordManager,
			vectorStore,
			options: {
				cleanup: 'incremental',
				sourceIdKey: 'source',
			},
		});
		expect(result.numAdded).toBe(1);
		expect(result.numSkipped).toBe(1);
		// 'beta' is gone from the source, so it must be deleted from the
		// store — which only works if delete-by-id actually matches rows.
		expect(result.numDeleted).toBe(1);
	});

	it('re-adds every document under forceUpdate', async () => {
		// Requires the upsert path: a plain INSERT errors on a duplicate key.
		const result = await index({
			docsSource: docs(['alpha', 'gamma']),
			recordManager,
			vectorStore,
			options: {
				cleanup: 'incremental',
				sourceIdKey: 'source',
				forceUpdate: true,
			},
		});
		expect(result.numAdded + result.numUpdated).toBeGreaterThan(0);
		expect(result.numSkipped).toBe(0);
	});

	it('full cleanup deletes everything no longer present', async () => {
		const result = await index({
			docsSource: docs(['only-this']),
			recordManager,
			vectorStore,
			options: {
				cleanup: 'full',
				sourceIdKey: 'source',
			},
		});
		expect(result.numAdded).toBe(1);
		expect(result.numDeleted).toBe(2);
	});

	it('leaves the store holding exactly the surviving document', async () => {
		const hits = await vectorStore.similaritySearch('only-this', 10);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.pageContent).toBe('only-this');
	});
});
