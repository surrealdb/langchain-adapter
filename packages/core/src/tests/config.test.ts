import { describe, expect, it } from 'vitest';
import {
	isTokenConfig,
	isUrlConfig,
	type SurrealDBStoreConfig,
} from '../config.js';

describe('config type guards', () => {
	it('detects URL config from username/password', () => {
		const cfg: SurrealDBStoreConfig = {
			url: 'ws://localhost:8000',
			username: 'root',
			password: 'root',
		};
		expect(isUrlConfig(cfg)).toBe(true);
		expect(isTokenConfig(cfg)).toBe(false);
	});

	it('detects token config from token field', () => {
		const cfg: SurrealDBStoreConfig = {
			url: 'ws://localhost:8000',
			token: 'eyJ.signed.jwt',
		};
		expect(isTokenConfig(cfg)).toBe(true);
		expect(isUrlConfig(cfg)).toBe(false);
	});
});
