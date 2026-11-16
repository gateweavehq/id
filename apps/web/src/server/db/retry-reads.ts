/** How many times a read is sent before its failure is the answer. */
export const READ_ATTEMPTS = 3;

/**
 * How long to wait before the second and the third, in milliseconds. Each is multiplied by a
 * random factor between 0.5 and 1.5, so reads that failed together do not come back together.
 */
const WAITS = [25, 100];

/**
 * A single `select`. The rule holds for single statements only: D1 runs every statement of a
 * text that holds several, and a later one may write, so a `;` with anything after it but
 * whitespace makes a statement that is sent once. A `;` inside a quoted value does too, which
 * errs the safe way.
 */
function isSingleSelect(query: string): boolean {
	return /^\s*select\b/i.test(query) && !/;\s*\S/.test(query);
}

/** The four ways a statement is sent. `bind` only makes another statement. */
const SENDS: ReadonlySet<PropertyKey> = new Set(["all", "raw", "first", "run"]);

/**
 * The failures that pass, each with the name it is logged under. The texts are the ones
 * Cloudflare's D1 error list answers with "Retry the operation", matched the way its "Retry
 * queries" page matches them, and the one the local runtime gives under load. Anything
 * else is the caller's at once: an overloaded database is not helped by more requests, a statement
 * that used too much CPU or memory or returned too much would again, and what is not known here
 * is not known to be safe to repeat. `Can't read from request stream because client disconnected`
 * is left out although the list says to retry it: it may be the caller's own doing, and a resend
 * cannot help a caller who left.
 */
const PASSING: readonly (readonly [label: string, text: string])[] = [
	["connection-lost", "Network connection lost"],
	["storage-reset", "storage caused object to be reset"],
	["code-updated", "reset because its code was updated"],
	["replica-disconnected", "Replica disconnected from primary"],
	["cannot-resolve", "Cannot resolve D1 DB due to transient issue on remote node"],
	["local-commit-token", "Failed to get session commit token"],
];

/** The name of a failure that passes, or nothing for one that is thrown as it is. */
export function passing(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	return PASSING.find(([, text]) => error.message.includes(text))?.[0];
}

/** What decides the waits. A test gives its own, so that it knows them and does not wait. */
export interface Waiting {
	/** A number from 0 up to 1, as `Math.random` gives. */
	random?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}

const pause = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function sendAgain<Answer>(
	send: () => Promise<Answer>,
	{ random = Math.random, sleep = pause }: Waiting,
) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await send();
		} catch (error) {
			const label = passing(error);
			if (!label || attempt >= READ_ATTEMPTS) throw error;
			// Never D1's own words: `Failed to parse body as JSON, got: …` can carry what a row held.
			console.warn(`d1: a read failed (${label}) and is sent again (attempt ${attempt})`);
			await sleep((WAITS[attempt - 1] ?? 100) * (0.5 + random()));
		}
	}
}

/**
 * The database, with a read that fails for a moment sent again before anyone is told. D1 can fail
 * so (its object restarting, a connection lost), and so can the local runtime under load, which is
 * how this was found, in Gateweave Agents' browser tests, where the same code runs: one failed
 * read of a session made a signed-in person's page a 500. Here one failed read of a session, an
 * app's row or a signing key would fail a sign-in to every app. D1 retries reads too where it can
 * tell the failure is passing; this covers what is left, and local runs, where nothing retries.
 * After the last attempt the failure reaches the caller.
 *
 * Only a single `select` is sent again, and only for a failure in `PASSING`. A write may have
 * happened although its answer was lost, and a batch may hold writes, so their failures stay the
 * caller's to handle. That holds for a `delete … returning` and an `update … returning` too,
 * although they answer with rows: they are how an authorization code, a sign-up code and a refresh
 * token are used up (the adapter's `consumeOne` and `incrementOne`), and each must run once. A
 * session from `withSession` is wrapped the same way.
 */
export function retryingReads(d1: D1Database, waiting: Waiting = {}): D1Database {
	// A deployment without a database serves nothing (`notSetUp` in server.ts): nothing to wrap.
	if (!d1) return d1;
	// `batch` reads its statements' own fields, so it gets the ones D1 made.
	const made = new WeakMap<object, D1PreparedStatement>();

	function watched(statement: D1PreparedStatement, read: boolean): D1PreparedStatement {
		const proxy = new Proxy(statement, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "bind") {
					return (...values: unknown[]) =>
						watched(Reflect.apply(value, target, values) as D1PreparedStatement, read);
				}
				if (read && SENDS.has(key)) {
					return (...args: unknown[]) =>
						sendAgain(() => Reflect.apply(value, target, args) as Promise<unknown>, waiting);
				}
				return value.bind(target);
			},
		});
		made.set(proxy, statement);
		return proxy;
	}

	/** The database itself, or a session of it: both prepare, batch and may open a session. */
	function wrapped<Source extends D1Database | D1DatabaseSession>(source: Source): Source {
		return new Proxy(source, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "prepare") {
					return (query: string) =>
						watched(
							Reflect.apply(value, target, [query]) as D1PreparedStatement,
							isSingleSelect(query),
						);
				}
				if (key === "batch") {
					return (statements: D1PreparedStatement[]) =>
						Reflect.apply(value, target, [
							statements.map((statement) => made.get(statement) ?? statement),
						]) as unknown;
				}
				if (key === "withSession") {
					return (...args: unknown[]) =>
						wrapped(Reflect.apply(value, target, args) as D1DatabaseSession);
				}
				// `getBookmark` and the rest answer as they did.
				return value.bind(target);
			},
		});
	}

	return wrapped(d1);
}
