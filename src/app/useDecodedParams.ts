import { useParams } from "@solidjs/router";

function safeDecode(value: string): string {
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
