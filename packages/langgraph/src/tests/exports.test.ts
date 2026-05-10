import { describe, expect, it } from 'vitest';
import { CheckpointSaver, Store } from '../index.js';

describe('package exports', () => {
	it('exposes the checkpoint saver class', () => {
		expect(typeof CheckpointSaver).toBe('function');
	});
	it('exposes the store class', () => {
		expect(typeof Store).toBe('function');
	});
});
