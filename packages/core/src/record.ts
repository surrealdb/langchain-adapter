import { escapeIdent, RecordId } from 'surrealdb';

export { escapeIdent };

/**
 * Build a SurrealDB {@link RecordId} for `table`.
 *
 * Always prefer this over hand-building a `"table:id"` string: a `RecordId`
 * is CBOR-encoded by the SDK when bound to a query, so the id part is never
 * escaped, parsed or re-parsed on the way to the server. String ids sent to
 * `INSERT` land in the id part *verbatim*, which silently produces
 * `table:⟨table:id⟩`.
 */
export function toRecordId(table: string, id: string | unknown[]): RecordId {
	return new RecordId(table, id as never);
}

/**
 * The id part of a record, as a string.
 *
 * This is the adapter id contract: what a store hands back is the id part,
 * *not* `table:id`, so the ids returned by `addDocuments` are exactly the
 * ids `delete({ ids })` accepts — no escaping, no parsing, no round-trip
 * asymmetry.
 *
 * Record ids whose id part is not a string (numbers, arrays, objects) have
 * no lossless string form that {@link toRecordId} could rebuild, so they
 * come back as the fully-qualified `toString()`. Callers that need to delete
 * those should use a filter rather than an id list.
 */
export function recordIdToString(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (value instanceof RecordId) {
		return typeof value.id === 'string' ? value.id : value.toString();
	}
	return String(value);
}

/**
 * True when `id` round-trips through {@link toRecordId} unchanged — i.e. it
 * came from a record whose id part is a plain string.
 */
export function isRoundTrippableId(id: string): boolean {
	return !id.includes(':');
}
