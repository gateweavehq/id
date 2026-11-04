/**
 * The URL's query as text, and nothing but text. The router's default reads each value as JSON and
 * writes one value per name, which would break the query the provider signs for a sign-in page:
 * `state=1e5` would become `100000`, and the repeated `ba_param` a JSON array. That query goes back
 * to the provider with every request from the page, and the signature covers each of those values.
 */
export function parseSearch(search: string): Record<string, unknown> {
	const parsed: Record<string, string | string[]> = Object.create(null);
	for (const [name, value] of new URLSearchParams(search)) {
		const earlier = parsed[name];
		if (earlier === undefined) parsed[name] = value;
		else if (typeof earlier === "string") parsed[name] = [earlier, value];
		else earlier.push(value);
	}
	return parsed;
}

export function stringifySearch(search: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(search)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) params.append(name, String(item));
		}
	}
	const query = params.toString();
	return query && `?${query}`;
}
