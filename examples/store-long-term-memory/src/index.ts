import { SurrealDBStore } from '@surrealdb/langgraph';

const store = new SurrealDBStore({
	surreal: {
		url: process.env.SURREALDB_URL ?? 'ws://localhost:8000',
		username: process.env.SURREALDB_USER ?? 'root',
		password: process.env.SURREALDB_PASS ?? 'root',
		namespace: 'examples',
		database: 'memory',
	},
});

await store.start();

// Per-user memory.
await store.put(['users', 'alice', 'preferences'], 'theme', { value: 'dark' });
await store.put(['users', 'alice', 'preferences'], 'language', { value: 'en' });
await store.put(['users', 'bob', 'preferences'], 'theme', { value: 'light' });

const aliceTheme = await store.get(['users', 'alice', 'preferences'], 'theme');
console.log('alice theme:', aliceTheme?.value);

const allAlice = await store.search(['users', 'alice']);
console.log('alice has', allAlice.length, 'items');

const namespaces = await store.listNamespaces({
	prefix: ['users'],
	maxDepth: 2,
});
console.log('user namespaces:', namespaces);

await store.stop();
