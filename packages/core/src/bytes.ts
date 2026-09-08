/**
 * Coerce whatever the SurrealDB driver hands back for a `bytes` column into a
 * `Uint8Array`.
 *
 * The representation varies with transport and driver version — a raw
 * `ArrayBuffer`, a view, a plain number array, or a `{ type: "Buffer", data }`
 * envelope — and every one of those has been observed round-tripping a
 * serialized payload. Callers deserialize the result, so a wrong guess here
 * surfaces as a corrupt payload much later; hence the explicit branches and a
 * throw rather than a silent best effort.
 */
export function toBytes(value: unknown, role = 'payload'): Uint8Array {
	if (value == null) {
		throw new Error(`toBytes: ${role} is null/undefined`);
	}

	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (Array.isArray(value)) return new Uint8Array(value as number[]);
	if (typeof value === 'string') return new TextEncoder().encode(value);
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (obj.type === 'Buffer' && Array.isArray(obj.data as unknown[])) {
			return new Uint8Array(obj.data as number[]);
		}
		if (obj.buffer instanceof ArrayBuffer) {
			return new Uint8Array(obj.buffer);
		}
	}
	throw new Error(
		`toBytes: unable to coerce ${role} (got ${typeof value})`,
	);
}
