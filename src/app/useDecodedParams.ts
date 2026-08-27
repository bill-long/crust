import { useParams } from "@solidjs/router";

/**
 * `decodeURIComponent` that returns the input unchanged rather than throwing.
 *
 * A stray `%` in a path is a `URIError`, and route segments come from the
 * address bar - so any hand-rolled decode of one is a crash waiting for a
 * malformed link. Exported so callers that parse the path themselves do not
 * grow their own try/catch.
 */
export function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Drop-in replacement for useParams that decodes percent-encoded values.
 *
 * SolidJS Router does not call decodeURIComponent on route params, so
 * characters like `:` in Matrix IDs (`!abc:server`) stay encoded as `%3A`
 * after encodeURIComponent round-tripping through the URL.
 */
export function useDecodedParams<
	T extends Record<string, string | undefined>,
>(): T {
	const raw = useParams<T>();
	return new Proxy(raw, {
		get(target, prop, receiver) {
			const val = Reflect.get(target, prop, receiver);
			return typeof val === "string" ? safeDecode(val) : val;
		},
	}) as T;
}
