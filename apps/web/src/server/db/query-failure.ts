import { DrizzleQueryError } from "drizzle-orm";
import { passing } from "./retry-reads";

/**
 * A query of D1 that failed, as everyone outside this folder gets it: what kind of failure it was
 * and a reference, and nothing of the statement.
 *
 * Drizzle's own error says `Failed query: select … params: …` with every value the statement was
 * given, and whoever catches it tends to log it or show it. Better Auth logged a session read
 * that failed, so the session's token was in the Worker's logs, and a page whose read failed
 * showed the statement and its values, in the page and in its HTML. Here the values are also the
 * hash of an authorization code or of a refresh token, an app's id and a person's address.
 *
 * The message holds the reference only, because a message travels: to a page, to a toast, into
 * the HTML. The kind and the statement are for the log, where the same reference finds them.
 *
 * Its cause is an error that says the kind and nothing else. Code that reads a failure's causes
 * for what went wrong still finds it: Better Auth's oauth-provider looks there for `no such
 * table`, to stay quiet about a database that has not been migrated yet.
 */
export class DatabaseError extends Error {
	/** Such as `D1_ERROR, SQLITE_ERROR, no such table: member`. Never a value. */
	readonly kind: string;
	/** Eight hex characters, made here, in the message and in the log line. */
	readonly reference: string;

	constructor(kind: string, reference: string) {
		super(`A database query failed (reference ${reference})`, { cause: new Error(kind) });
		this.name = "DatabaseError";
		this.kind = kind;
		this.reference = reference;
	}
}

/**
 * What D1 says in fixed words, each with the name it is logged under, beside the passing ones
 * `retry-reads.ts` names. The texts are from Cloudflare's D1 error list and SQLite's own. A name
 * says which of them was in D1's words and repeats none of them.
 */
const PHRASES: readonly (readonly [label: string, text: string])[] = [
	["queued-too-long", "Requests queued for too long"],
	["queue-full", "Too many requests queued"],
	["overloaded", "D1 DB is overloaded"],
	["cpu-reset", "exceeded its CPU time limit"],
	["memory-reset", "exceeded its memory limit"],
	["storage-timeout", "storage operation exceeded timeout"],
	["response-too-large", "exceeded the maximum response size"],
	["too-many-api-requests", "Too many API requests by single worker invocation"],
	["too-many-variables", "too many SQL variables"],
	["syntax-error", ": syntax error"],
];

/**
 * What the triggers in `migrations/` say when they refuse a write (`RAISE(ABORT, …)`): the
 * migrations' own words, so they hold nothing of a row, and without them every refusal reads
 * `SQLITE_CONSTRAINT` alone. A trigger added with new words belongs here, which
 * `query-failure.test.ts` checks against the migrations.
 */
const REFUSALS = [
	"a workspace must keep an owner",
	"a group an app names cannot be deleted",
	"sign-up is closed here",
	"a server must keep its owner",
	"the sign-up list is full",
];

/**
 * What SQLite may be quoted on: a constraint or a missing table or column, and the names it gives,
 * which are the schema's, and a trigger's refusal. Only where D1 puts SQLite's words, right after
 * its own code, and only up to the next colon or the end: the same words further in may be what a
 * row held.
 */
const QUOTABLE = new RegExp(
	`^D1_[A-Z_]+: ((?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed(?:: [\\w.]+(?:, [\\w.]+)*)?|no such (?:table|column): [\\w.]+|${REFUSALS.join("|")})(?= at offset \\d+:|:|$)`,
);

/**
 * The kind of failure, from D1's words: its code at their start, SQLite's at their end, the name
 * of a fixed phrase, and what `QUOTABLE` allows. Never the words themselves: `Failed to parse body
 * as JSON, got: …` can carry what a row held.
 */
function kindOf(cause: unknown): string {
	const said = cause instanceof Error ? cause.message : "";
	const parts = [
		/^D1_[A-Z_]+/.exec(said)?.[0],
		// As D1 ends them: `: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`.
		/: (SQLITE_[A-Z_]+)(?: \(extended: SQLITE_[A-Z_]+\))?$/.exec(said)?.[1],
		passing(cause) ?? PHRASES.find(([, text]) => said.includes(text))?.[0],
		QUOTABLE.exec(said)?.[1],
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "unknown";
}

function newReference(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How much of a statement is logged. The longest the app sends are a few hundred characters. */
const STATEMENT_LENGTH = 600;

/**
 * Makes the error for what D1 said, and logs it once, with the statement if there was one: the
 * text with its `?`, as Drizzle sent it, never the values. The app writes no value into a
 * statement's text: `sql` templates bind what they are given, and the one `sql.raw`, in
 * `workspace-apps.ts`, takes only the column names of a row the code makes. So the text is the
 * code's own.
 */
function failed(cause: unknown, statement?: string): DatabaseError {
	const error = new DatabaseError(kindOf(cause), newReference());
	const text = statement?.replace(/\s+/g, " ").trim();
	const shown =
		text && text.length > STATEMENT_LENGTH ? `${text.slice(0, STATEMENT_LENGTH)}…` : text;
	console.error(
		`d1: a query failed (${error.kind}), reference ${error.reference}${shown ? `: ${shown}` : ""}`,
	);
	return error;
}

/** Drizzle's error for a failed query, by its class or by what it carries. */
function isQueryError(error: unknown): error is Error & { query: unknown } {
	if (error instanceof DrizzleQueryError) return true;
	return error instanceof Error && "query" in error && "params" in error;
}

/** How a prepared query is sent. `execute` goes through one of these. */
const SENDS = ["run", "all", "get", "values"] as const;

type Method = (...args: unknown[]) => unknown;

/** The parts of Drizzle's session this reaches for. It does not export their types. */
interface Session {
	prepareQuery: Method;
	/** The D1 binding. A batch goes to it whole. */
	client: { batch: Method };
}

function isSession(session: unknown): session is Session {
	if (typeof session !== "object" || session === null) return false;
	const { prepareQuery, client } = session as Partial<Session>;
	return (
		typeof prepareQuery === "function" &&
		typeof client === "object" &&
		client !== null &&
		typeof client.batch === "function"
	);
}

const UNREACHABLE = "so a failed query would carry its values";

/**
 * The database, with every failed query thrown as a `DatabaseError`.
 *
 * Drizzle makes its error inside the query, above the D1 binding and below everything that
 * awaits one, so the only place that sees all of them is where its session prepares a query:
 * every builder, `db.query`, `db.run` and a transaction go through `prepareQuery`. A batch is
 * sent whole by the session's client, and fails in D1's words, so that is where it is caught:
 * what fails before a batch is sent, while it is put together, is not the database's and is
 * thrown as it is.
 *
 * None of this is in Drizzle's public types. If a version has no such session, this throws when
 * the Worker starts, since `server/auth` makes the database as it loads, and in every test. If a
 * prepared query is no longer sent by any of the four methods, it throws at the first query.
 * Either is better than the statements being in the errors again.
 */
export function withoutStatements<Db extends object>(db: Db): Db {
	const session: unknown = Reflect.get(db, "session");
	if (!isSession(session)) {
		throw new Error(`Drizzle's session cannot be reached, ${UNREACHABLE}`);
	}
	const { prepareQuery, client } = session;

	session.prepareQuery = (...given: unknown[]) => {
		const prepared = Reflect.apply(prepareQuery, session, given) as Record<string, unknown>;
		let watched = 0;
		for (const send of SENDS) {
			const original = prepared[send];
			if (typeof original !== "function") continue;
			watched += 1;
			prepared[send] = async (...args: unknown[]) => {
				try {
					return await Reflect.apply(original, prepared, args);
				} catch (error) {
					// `all` and `get` may go through `values`, which has made the error by then.
					if (!isQueryError(error)) throw error;
					throw failed(error.cause, typeof error.query === "string" ? error.query : undefined);
				}
			};
		}
		if (watched === 0) {
			throw new Error(`Drizzle's prepared query is sent some other way, ${UNREACHABLE}`);
		}
		return prepared;
	};

	session.client = new Proxy(client, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key !== "batch") return value.bind(target);
			return async (...given: unknown[]) => {
				try {
					return await Reflect.apply(value, target, given);
				} catch (error) {
					throw failed(error);
				}
			};
		},
	});

	return db;
}
