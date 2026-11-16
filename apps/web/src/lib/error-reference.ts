/**
 * The reference a failure was logged under, if its message has one, as a failed database query's
 * does (`DatabaseError` in `server/db/query-failure.ts`). It is all of an error that a page
 * shows: eight hex characters, which say nothing by themselves and find the line in the log.
 *
 * Looked for in the error's causes too: Better Auth throws its own `Failed to get session` for a
 * session read that failed, with the database's error as the cause. A cause does not cross from
 * the server to the browser, so this finds it only where the page is rendered on the server.
 */
export function referenceIn(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		const found = /\(reference ([0-9a-f]{8})\)/.exec(current.message)?.[1];
		if (found) return found;
		current = current.cause;
	}
	return undefined;
}
