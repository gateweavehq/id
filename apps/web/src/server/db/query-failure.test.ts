import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../auth/app-row";
import { createAuth } from "../auth/config";
import { createDb, schema } from ".";
import { faulty, LOCAL, migratedD1 } from "./faulty-d1";
import { DatabaseError, withoutStatements } from "./query-failure";
import { READ_ATTEMPTS } from "./retry-reads";

// A query of D1 that failed for good. Drizzle's error for it is `Failed query: select … params: …`,
// with every value the statement was given. Better Auth logged the one for a session read, token
// included, and a page showed the one for its own read.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("query-failure-test"));
	// As the Worker tests do, so that a test can make people at will.
	await real.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
});

afterAll(async () => {
	await dispose?.();
});

/** Every call to the console, as the console would print it: an error's fields and causes too. */
let printed: string[];

beforeEach(() => {
	printed = [];
	for (const level of ["error", "warn", "info", "log", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			printed.push(
				`${level}: ${args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 8 }))).join(" ")}`,
			);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

const logged = () => printed.join("\n");

/** The lines this module logs: a kind and a reference each, and the statement if there was one. */
const failures = () =>
	printed.flatMap((line) => {
		const found = /^error: d1: a query failed \((.+?)\), reference ([0-9a-f]{8})(?:: (.+))?$/.exec(
			line,
		);
		return found ? [{ kind: found[1], reference: found[2], statement: found[3] }] : [];
	});

/** What threw, or nothing. */
async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return undefined;
}

const PASSWORD = "a-long-test-password";
const baseURL = "https://id.test";

function authOn(d1: D1Database) {
	const db = createDb(d1);
	const auth = createAuth({
		db,
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL,
		oidc: { issuer: baseURL, pairwiseSecret: "a-test-secret-for-each-apps-own-ids" },
	});
	return { db, auth };
}

/** Someone with an account and a session. Nobody signs up with a password here, so the rows are made. */
async function signedUp(d1: D1Database, email: string) {
	const { db, auth } = authOn(d1);
	const id = `u-${email}`;
	const now = new Date();
	await db
		.insert(schema.user)
		.values({ id, name: "Rio", email, emailVerified: true, createdAt: now, updatedAt: now });
	await db.insert(schema.account).values({
		id: `a-${email}`,
		accountId: id,
		providerId: "credential",
		userId: id,
		password: await hashPassword(PASSWORD),
		createdAt: now,
		updatedAt: now,
	});
	const { headers } = await auth.api.signInEmail({
		body: { email, password: PASSWORD },
		returnHeaders: true,
	});
	const cookie = headers
		.getSetCookie()
		.map((line) => line.split(";")[0])
		.join("; ");
	return { id, db, auth, cookie, headers: new Headers({ cookie, origin: baseURL }) };
}

describe("a session read that failed for good", () => {
	it("logs the statement and none of its values, so no token", async () => {
		const { database, state } = faulty(real);
		const { auth, cookie } = await signedUp(database, "rio@failure.test");
		const value = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)?.[1] ?? "");
		const token = value.split(".")[0] ?? "";
		// The token the cookie carries is the one the statement looks for.
		const stored = await real.prepare("select token from session").all<{ token: string }>();
		expect(stored.results.map((row) => row.token)).toContain(token);

		printed.length = 0;
		state.failures = READ_ATTEMPTS;
		const error = await thrownBy(() => auth.api.getSession({ headers: new Headers({ cookie }) }));

		// Better Auth logs what it caught, and throws its own error with that as the cause.
		expect(logged()).toContain("[Better Auth]");
		expect(logged()).not.toContain(token);
		expect(logged()).not.toContain("Failed query");
		expect(logged()).not.toContain("params");
		// What Better Auth logs is the error, which has nothing of the statement.
		const theirs = printed.filter((line) => line.includes("[Better Auth]")).join("\n");
		expect(theirs).not.toMatch(/select/i);
		expect(inspect(error, { depth: 8 })).not.toContain(token);
		expect(inspect(error, { depth: 8 })).not.toMatch(/select/i);

		// Still enough to find it by: the kind in the log, under the reference the error has.
		const cause = (error as Error).cause;
		expect(cause).toBeInstanceOf(DatabaseError);
		const { kind, reference } = cause as DatabaseError;
		expect(kind).toBe("D1_ERROR, local-commit-token");
		const [failure, ...others] = failures();
		expect(others).toEqual([]);
		expect(failure).toMatchObject({ kind, reference });
		// The statement as it was sent, with a `?` where the token was.
		expect(failure?.statement).toMatch(/^select "id", .* where "session"\."token" = \? limit \?$/);
		// The cause says the kind and nothing else, for code that reads causes.
		expect(((cause as Error).cause as Error).message).toBe(kind);
		expect((cause as DatabaseError).message).toBe(
			`A database query failed (reference ${reference})`,
		);
	});
});

describe("a query that failed", () => {
	const SECRET = "a-value-nobody-should-see";

	it("throws an error without its statement or its values", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";

		const error = await thrownBy(() =>
			db.select().from(schema.member).where(eq(schema.member.userId, SECRET)).all(),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		const shown = inspect(error, { depth: 8 });
		expect(shown).not.toContain(SECRET);
		expect(shown).not.toMatch(/select|params|user_id/i);
		expect((error as DatabaseError).kind).toBe("D1_ERROR, queued-too-long");
		expect(failures()).toMatchObject([
			{ kind: "D1_ERROR, queued-too-long", reference: (error as DatabaseError).reference },
		]);
		// The log has the statement, with a `?` where the value was.
		expect(failures()[0]?.statement).toMatch(/ from "member" where "member"\."user_id" = \?$/);
		expect(logged()).not.toContain(SECRET);
		expect(logged()).not.toContain("params");
	});

	it("logs a statement with a token among its values, and not the token", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		const token = "kJ8sT0kEnT0kEnT0kEnT0kEnT0kEn";
		state.failures = 1;
		state.message = "D1_ERROR: something nobody has seen before";

		await thrownBy(() =>
			db.select().from(schema.session).where(eq(schema.session.token, token)).all(),
		);

		expect(failures()[0]?.statement).toMatch(/ from "session" where "session"\."token" = \?$/);
		expect(logged()).not.toContain(token);
	});

	it("cuts a long statement short", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		const ids = Array.from({ length: 400 }, (_, index) => `id-${index}`);

		await thrownBy(() =>
			db.select().from(schema.member).where(inArray(schema.member.userId, ids)).all(),
		);

		const statement = failures()[0]?.statement ?? "";
		expect(statement.length).toBe(601);
		expect(statement.endsWith("…")).toBe(true);
	});

	// What Cloudflare's D1 error list and SQLite say in fixed words, by a name each.
	it.each([
		["overloaded", "D1_ERROR: D1 DB is overloaded."],
		["queue-full", "D1_ERROR: D1 DB is overloaded. Too many requests queued."],
		["cpu-reset", "D1_ERROR: D1 DB exceeded its CPU time limit and was reset."],
		["memory-reset", "D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset."],
		[
			"storage-timeout",
			"D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
		],
		[
			"response-too-large",
			"D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB",
		],
		["too-many-variables", "D1_ERROR: too many SQL variables at offset 412: SQLITE_ERROR"],
		["syntax-error", 'D1_ERROR: near "form": syntax error at offset 9: SQLITE_ERROR'],
	])("names what D1 says in fixed words: %s", async (label, message) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = message;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		const sqlite = message.endsWith(": SQLITE_ERROR") ? "SQLITE_ERROR, " : "";
		expect((error as DatabaseError).kind).toBe(`D1_ERROR, ${sqlite}${label}`);
	});

	it("names a failure without D1's code by its fixed words alone", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = "Too many API requests by single worker invocation.";

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("too-many-api-requests");
	});

	// Words that name a table or a code may be what a row held, wherever D1 quotes one.
	it.each([
		[
			"a table's name inside a body it could not read",
			'D1_ERROR: Failed to parse body as JSON, got: {"note":"no such table: SECRETWORD"}',
			"SECRETWORD",
		],
		["a code in the middle of its words", "D1_ERROR: row said SQLITE_SECRET_WORD", "SECRET_WORD"],
		[
			"a constraint's name after a colon further in",
			"D1_ERROR: Failed to parse body as JSON, got: UNIQUE constraint failed: SECRETWORD",
			"SECRETWORD",
		],
	])("quotes D1 only where it speaks for itself, not %s", async (_what, message, word) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = message;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR");
		expect(inspect(error, { depth: 8 })).not.toContain(word);
		expect(logged()).not.toContain(word);
	});

	it.each([
		["get", (db: ReturnType<typeof createDb>) => db.select().from(schema.member).get()],
		["values", (db: ReturnType<typeof createDb>) => db.select().from(schema.member).values()],
		["run", (db: ReturnType<typeof createDb>) => db.delete(schema.member).run()],
		["await", async (db: ReturnType<typeof createDb>) => await db.select().from(schema.member)],
		[
			"the relational API",
			(db: ReturnType<typeof createDb>) =>
				db.query.member.findFirst({ where: eq(schema.member.userId, SECRET) }),
		],
		[
			"a transaction",
			(db: ReturnType<typeof createDb>) =>
				db.transaction((tx) => tx.select().from(schema.member).all()),
		],
		// The ways ID asks that the builders do not cover: `deployment.ts` and `delete-account.ts`
		// write their reads by hand, and a code's row is deleted to read it.
		[
			"a hand-written read of one row",
			(db: ReturnType<typeof createDb>) =>
				db.get(sql`SELECT count(*) AS n FROM member WHERE user_id = ${SECRET}`),
		],
		[
			"a hand-written read of several",
			(db: ReturnType<typeof createDb>) =>
				db.all(sql`SELECT id FROM member WHERE user_id = ${SECRET}`),
		],
		["a count", (db: ReturnType<typeof createDb>) => db.$count(schema.member)],
		[
			"a delete that returns its rows",
			(db: ReturnType<typeof createDb>) =>
				db
					.delete(schema.verification)
					.where(eq(schema.verification.identifier, SECRET))
					.returning()
					.all(),
		],
	])("whichever way it was sent: %s", async (_way, send) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		// A transaction's `begin` and `rollback` fail too, whichever comes first.
		state.failures = 3;
		state.message = "D1_ERROR: something nobody has seen before";

		const error = await thrownBy(() => send(db));

		expect(error).toBeInstanceOf(DatabaseError);
		expect(inspect(error, { depth: 8 })).not.toMatch(/select|delete|begin|params/i);
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("names a constraint, which is the schema's and no value", async () => {
		const db = createDb(real);
		const row = { id: "twice", identifier: SECRET, value: SECRET, expiresAt: new Date(1) };
		await db.insert(schema.verification).values(row);

		const error = await thrownBy(() => db.insert(schema.verification).values(row).run());

		expect(error).toBeInstanceOf(DatabaseError);
		expect((error as DatabaseError).kind).toBe(
			"D1_ERROR, SQLITE_CONSTRAINT, UNIQUE constraint failed: verification.id",
		);
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("names a passing failure that outlasted its resends", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = READ_ATTEMPTS;
		state.message = LOCAL;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR, local-commit-token");
	});

	it("repeats nothing D1 said beyond that: its words can carry what a row held", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = `D1_ERROR: Failed to parse body as JSON, got: {"token":"${SECRET}"}`;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR");
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("says as little when a batch fails, which fails in D1's words", async () => {
		const db = createDb(real);

		const error = await thrownBy(() =>
			db.batch([
				db.insert(schema.verification).values({
					id: "batched",
					identifier: SECRET,
					value: SECRET,
					expiresAt: new Date(1),
				}),
				db.insert(schema.verification).values({
					id: "batched",
					identifier: SECRET,
					value: SECRET,
					expiresAt: new Date(1),
				}),
			]),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect((error as DatabaseError).kind).toContain("UNIQUE constraint failed: verification.id");
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("leaves alone what fails while a batch is put together, before the database is asked", async () => {
		const db = createDb(real);
		const broken = new TypeError("not a query");
		const notAQuery = {
			_prepare() {
				throw broken;
			},
		};

		const error = await thrownBy(() =>
			db.batch([notAQuery] as unknown as Parameters<typeof db.batch>[0]),
		);

		expect(error).toBe(broken);
		expect(printed).toEqual([]);
	});

	it("leaves a query that worked alone", async () => {
		const db = createDb(real);
		expect(await db.select().from(schema.member).where(eq(schema.member.userId, "nobody"))).toEqual(
			[],
		);
		expect(printed).toEqual([]);
	});
});

// None of what `withoutStatements` reaches for is in Drizzle's public types, so a version may
// take it away. Then the statements would be in the errors again, and nothing would say so.
describe("a Drizzle that is not as expected", () => {
	const client = { batch: async () => [] };

	it.each([
		["no session", {}],
		["a session that prepares no query", { session: { client } }],
		["a session without its client", { session: { prepareQuery: () => ({}) } }],
		["a client that sends no batch", { session: { prepareQuery: () => ({}), client: {} } }],
	])("is refused when the database is made: %s", (_what, db) => {
		expect(() => withoutStatements(db)).toThrow("Drizzle's session cannot be reached");
	});

	it("is refused at the first query when a prepared query is sent by another name", () => {
		const session = { prepareQuery: () => ({ execute: async () => [] }), client };
		withoutStatements({ session });

		expect(() => session.prepareQuery()).toThrow("Drizzle's prepared query is sent some other way");
	});

	it("is accepted when a prepared query has any of the four", async () => {
		const session = { prepareQuery: () => ({ all: async () => ["a row"] }), client };
		withoutStatements({ session });

		expect(await session.prepareQuery().all()).toEqual(["a row"]);
	});
});

// Better Auth's oauth-provider writes the resources it is given into `oauth_resource` as it starts,
// and tells a database not migrated yet from a real failure by reading the failure's causes for
// SQLite's words (`logStartupSeedFailure`). ID gives it no resources, so it asks nothing then. The
// cause is still what it would read, for the day ID does.
describe("a database that has not been migrated yet", () => {
	/** As the oauth-provider looks: up to five causes deep, for these words. */
	function readsAsAMissingTable(error: unknown): boolean {
		let current = error;
		for (let depth = 0; current && depth < 5; depth++) {
			if (/no such table/i.test(current instanceof Error ? current.message : String(current))) {
				return true;
			}
			current = current instanceof Error ? current.cause : undefined;
		}
		return false;
	}

	it("is asked nothing as Better Auth starts, and its missing table is still read as one", async () => {
		const { d1, dispose: disposeEmpty } = await migratedD1("query-failure-empty", {
			migrate: false,
		});
		try {
			const { auth, db } = authOn(d1);
			await auth.$context;

			expect(failures()).toEqual([]);
			expect(printed).toEqual([]);

			const error = await thrownBy(() => db.select().from(schema.oauthResource).all());

			expect(error).toBeInstanceOf(DatabaseError);
			expect((error as DatabaseError).message).not.toMatch(/no such table/);
			expect(readsAsAMissingTable(error)).toBe(true);
			expect((error as DatabaseError).kind).toBe(
				"D1_ERROR, SQLITE_ERROR, no such table: oauth_resource",
			);
		} finally {
			await disposeEmpty();
		}
	});

	it("is not what another failure reads as", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";

		const error = await thrownBy(() => db.select().from(schema.oauthResource).all());

		expect(readsAsAMissingTable(error)).toBe(false);
	});
});

describe("what SQLite refused, in the local runtime's own words", () => {
	it.each([
		["a table that is not there", "select * from nope", "SQLITE_ERROR, no such table: nope"],
		["a column that is not there", "select nope from member", "SQLITE_ERROR, no such column: nope"],
		["a statement it cannot read", "selec 1", "SQLITE_ERROR, syntax-error"],
	])("names %s", async (_what, statement, kind) => {
		const db = createDb(real);

		const error = await thrownBy(() => db.run(sql.raw(statement)));

		expect((error as DatabaseError).kind).toBe(`D1_ERROR, ${kind}`);
	});
});

// ID's triggers refuse a write in words of their own (`RAISE(ABORT, …)` in the migrations).
// They are the migrations' words, never a row's, and say which rule held.
describe("what a trigger refused", () => {
	/** Every refusal the migrations hold, as SQLite will word it. */
	function refusals(): string[] {
		const migrations = resolve(import.meta.dirname, "../../../migrations");
		const found = new Set<string>();
		for (const file of readdirSync(migrations).filter((each) => each.endsWith(".sql"))) {
			const text = readFileSync(join(migrations, file), "utf8");
			for (const [, words] of text.matchAll(/RAISE\s*\(\s*ABORT\s*,\s*'([^']+)'\s*\)/gi)) {
				if (words) found.add(words);
			}
		}
		return [...found];
	}

	it("is named for every refusal the migrations hold", async () => {
		const all = refusals();
		expect(all.length).toBeGreaterThanOrEqual(5);
		for (const words of all) {
			const { database, state } = faulty(real);
			const db = createDb(database);
			state.failures = 1;
			// As D1 words a trigger's refusal.
			state.message = `D1_ERROR: ${words}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`;

			const error = await thrownBy(() => db.delete(schema.member).run());

			expect((error as DatabaseError).kind).toBe(`D1_ERROR, SQLITE_CONSTRAINT, ${words}`);
		}
	});

	it("is named when the database itself refuses, and the values are not", async () => {
		const db = createDb(real);
		const SECRET = "a-value-nobody-should-see";
		const now = new Date();
		await db
			.insert(schema.user)
			.values({ id: "trigger-owner", name: SECRET, email: "trigger-owner@failure.test" });
		await db
			.insert(schema.organization)
			.values({ id: "trigger-space", name: SECRET, slug: "trigger-space", createdAt: now });
		await db.insert(schema.member).values({
			id: "trigger-member",
			organizationId: "trigger-space",
			userId: "trigger-owner",
			role: "owner",
			createdAt: now,
		});
		printed.length = 0;

		const error = await thrownBy(() =>
			db.delete(schema.member).where(eq(schema.member.id, "trigger-member")).run(),
		);

		expect((error as DatabaseError).kind).toBe(
			"D1_ERROR, SQLITE_CONSTRAINT, a workspace must keep an owner",
		);
		expect(failures()[0]?.statement).toBe('delete from "member" where "member"."id" = ?');
		expect(logged()).not.toContain("trigger-member");
	});

	it("is not quoted from further in, where the words may be a row's", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message =
			'D1_ERROR: Failed to parse body as JSON, got: {"note":"sign-up is closed here"}';

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR");
	});
});

// Nothing in ID reads a database error to decide what to answer: what could be a duplicate or a
// refusal is asked about first, or written so that a duplicate is no error (`onConflictDoNothing`).
// So a `DatabaseError` in place of Drizzle's must leave each of these answers as it was, and the
// database must not have been asked for something it refuses.
describe("an answer that the database could have refused", () => {
	type Person = Awaited<ReturnType<typeof signedUp>>;

	/** A request as a page sends it, and the status and the code of what Better Auth answered. */
	async function post(person: Person, path: string, body: object) {
		const response = await person.auth.handler(
			new Request(`${baseURL}/api/auth${path}`, {
				method: "POST",
				headers: {
					origin: baseURL,
					cookie: person.cookie,
					"content-type": "application/json",
					"cf-connecting-ip": "203.0.113.7",
				},
				body: JSON.stringify(body),
			}),
		);
		const text = await response.text();
		let answer: { id?: string; code?: string } = {};
		try {
			answer = JSON.parse(text) as typeof answer;
		} catch {}
		return { status: response.status, code: answer.code, id: answer.id, text };
	}

	async function workspaceOf(person: Person, slug: string) {
		const made = await post(person, "/organization/create", { name: slug, slug });
		expect(made.status).toBe(200);
		return made.id ?? "";
	}

	it("still tells a workspace address that is taken from a failure", async () => {
		const person = await signedUp(real, "eli@answers.test");
		await workspaceOf(person, "taken-once");
		printed.length = 0;

		const refused = await post(person, "/organization/create", {
			name: "Taken",
			slug: "taken-once",
		});

		expect(refused).toMatchObject({ status: 400, code: "ORGANIZATION_ALREADY_EXISTS" });
		expect(failures()).toEqual([]);
	});

	it("still tells a name that belongs to an app everyone can use from a failure", async () => {
		const person = await signedUp(real, "ivy@answers.test");
		const organizationId = await workspaceOf(person, "apps-here");
		const everyones = appRow({
			app: "wiki",
			name: "Wiki",
			redirectUris: ["https://wiki.answers.test/callback"],
		});
		await real.prepare(insertStatement(everyones.row)).run();
		printed.length = 0;

		const refused = await post(person, "/workspaces/apps/add", {
			organizationId,
			name: "wiki",
			redirectUris: ["https://wiki.elsewhere.test/callback"],
		});

		expect(refused).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
		expect(failures()).toEqual([]);
	});

	it("still tells a group's name that is taken from a failure", async () => {
		const person = await signedUp(real, "joy@answers.test");
		const group = { organizationId: await workspaceOf(person, "groups-here"), name: "Engineering" };
		expect((await post(person, "/workspaces/groups/create", group)).status).toBe(200);
		printed.length = 0;

		const refused = await post(person, "/workspaces/groups/create", group);

		expect(refused).toMatchObject({ status: 400, code: "GROUP_NAME_TAKEN" });
		expect(failures()).toEqual([]);
	});

	it("names the constraint alone when an address that has an account is written again", async () => {
		const { auth, db } = await signedUp(real, "dee@answers.test");
		const { internalAdapter } = await auth.$context;
		printed.length = 0;

		// Nothing writes this: a sign-up code and GitHub's callback look the address up first, as
		// here. `user.email` is unique, so the database would refuse it.
		expect(await internalAdapter.findUserByEmail("dee@answers.test")).not.toBeNull();
		const error = await thrownBy(() =>
			db.insert(schema.user).values({
				id: "u-dee-again",
				name: "Dee again",
				email: "dee@answers.test",
				emailVerified: true,
			}),
		);

		expect((error as DatabaseError).kind).toBe(
			"D1_ERROR, SQLITE_CONSTRAINT, UNIQUE constraint failed: user.email",
		);
		expect(inspect(error, { depth: 8 })).not.toContain("dee@answers.test");
		expect(logged()).not.toContain("dee@answers.test");
	});

	// `delete-account.ts` asks whether the person is a workspace's only owner, then deletes the
	// account in one statement. Another owner leaving in between makes the trigger refuse it. That
	// was a 500 before, with the account kept, and "signing in again gets them the reason". It
	// still is, and the log says which rule held and nothing of the person.
	it("still answers 500 and keeps the account of an only owner when the trigger is what refused", async () => {
		const { database, state } = faulty(real);
		const going = await signedUp(database, "fay@answers.test");
		const other = await signedUp(real, "gus@answers.test");
		const organizationId = await workspaceOf(going, "shared-space");
		await real
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
			)
			.bind("other-owner", organizationId, other.id, Date.now())
			.run();

		// The other owner leaves after the check and before the delete.
		state.before = async (query) => {
			if (!/^delete from "user"/.test(query)) return;
			state.before = undefined;
			await real.prepare("DELETE FROM member WHERE id = ?").bind("other-owner").run();
		};
		printed.length = 0;
		const answer = await post(going, "/account/delete", { password: PASSWORD });

		expect(answer.status).toBe(500);
		expect(answer.text).not.toMatch(/delete|params|constraint/i);
		expect(failures().map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_CONSTRAINT, a workspace must keep an owner",
		]);
		expect(failures()[0]?.statement).toMatch(/^delete from "user" where "user"\."id" = \?/);
		expect(logged()).not.toContain(going.id);
		expect(logged()).not.toContain("Failed query");
		const kept = await real
			.prepare("SELECT count(*) AS n FROM user WHERE id = ?")
			.bind(going.id)
			.first<{ n: number }>();
		expect(kept?.n).toBe(1);
	});
});

// What makes a database without a D1 binding to watch.
describe("without a database", () => {
	it("is left as Drizzle made it, so a deployment with no binding starts and says so", () => {
		expect(() => createDb(undefined as unknown as D1Database)).not.toThrow();
	});

	it("refuses a stand-in that is no binding, as the schema generator's once was", () => {
		expect(() => createDb({} as D1Database)).toThrow("Drizzle's session cannot be reached");
	});

	it("still loads the configuration the schema generator reads, whose database is no binding", async () => {
		const { auth } = await import("../auth/cli");

		expect(auth.options.plugins?.length).toBeGreaterThan(0);
		// Whatever a plugin asks of it as it starts fails, as it always has there: waited for, so
		// that it is said inside this test.
		await auth.$context;
		expect(logged()).not.toContain("Drizzle's session cannot be reached");
	});
});
