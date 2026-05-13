export interface ScopeWireEntry {
	key: string;
	value: string;
}

export function serialiseScope(
	scope?: Record<string, string> | null,
): ScopeWireEntry[] | undefined {
	if (!scope) return undefined;
	return Object.entries(scope).map(([k, v]) => ({
		key: String(k),
		value: String(v),
	}));
}

export function deserialiseScope(
	wire?: ScopeWireEntry[] | null,
): Record<string, string> {
	if (!wire) return {};
	const out: Record<string, string> = {};
	for (const entry of wire) {
		if (entry && entry.key != null && entry.value != null) {
			out[String(entry.key)] = String(entry.value);
		}
	}
	return out;
}
