import { Spectron, type SpectronOptions } from '@surrealdb/spectron';

/**
 * Config accepted by the Spectron-backed adapters: either a pre-constructed
 * {@link Spectron} client, or the options to build one. Every field is optional
 * so it can fall back to the `SPECTRON_ENDPOINT` / `SPECTRON_API_KEY` /
 * `SPECTRON_CONTEXT` environment variables.
 */
export type SpectronClientConfig = Spectron | Partial<SpectronOptions>;

/**
 * Resolves a {@link Spectron} client from adapter config.
 *
 * A pre-constructed client is returned as-is. Otherwise `endpoint`, `apiKey`,
 * and `context` are taken from the config, falling back to the
 * `SPECTRON_ENDPOINT`, `SPECTRON_API_KEY`, and `SPECTRON_CONTEXT` environment
 * variables. Each is required — a missing one throws a clear error.
 */
export function resolveSpectron(client: SpectronClientConfig): Spectron {
	if (client instanceof Spectron) return client;

	const endpoint = client.endpoint ?? process.env.SPECTRON_ENDPOINT;
	const apiKey = client.apiKey ?? process.env.SPECTRON_API_KEY;
	const context = client.context ?? process.env.SPECTRON_CONTEXT;

	if (!endpoint) {
		throw new Error(
			'Spectron: missing `endpoint`. Pass it explicitly or set SPECTRON_ENDPOINT.',
		);
	}
	if (!apiKey) {
		throw new Error(
			'Spectron: missing `apiKey`. Pass it explicitly or set SPECTRON_API_KEY.',
		);
	}
	if (!context) {
		throw new Error(
			'Spectron: missing `context`. Pass it explicitly or set SPECTRON_CONTEXT.',
		);
	}

	return new Spectron({ ...client, endpoint, apiKey, context });
}
