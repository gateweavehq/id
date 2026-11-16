import { hashPassword } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../auth/app-row";
import { createAuth } from "../auth/config";
import { mayMakeAccount, signUpState } from "../auth/deployment";
import { createDb, schema } from ".";
import { faulty, LOCAL, migratedD1 } from "./faulty-d1";
import { pruneExpired } from "./prune";
import { DatabaseError } from "./query-failure";
import { READ_ATTEMPTS, retryingReads } from "./retry-reads";

// A read of D1 that fails for a moment. Under load, the local runtime's D1 answered one read of a
// session with the error below, and a signed-in person's page was a 500 that said "Failed to get
// session". Here every app signs people in through such reads. The database is a real one, with
// the failure put in front of it.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("retry-reads-test"));
	// As the Worker tests do, so that a test can make people at will.
	await real.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
});

afterAll(async () => {
	await dispose?.();
});

let warned: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warned = vi.spyOn(console, "warn").mockImplementation(() => {});
	// Better Auth logs a session read that failed for good.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const PASSWORD = "a-long-test-password";

function authOn(d1: D1Database) {
	const db = createDb(d1);
	const auth = createAuth({
		db,
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL: "https://id.test",
		oidc: { issuer: "https://id.test", pairwiseSecret: "a-test-secret-for-each-apps-own-ids" },
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
	return { auth, cookie };
}

/** Everything `console.warn` was given, as one text. */
const logged = () =>
	warned.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");

it("answers a session read that failed once", async () => {
	const { database, state } = faulty(real);
	const { auth, cookie } = await signedUp(database, "rio@example.com");

	state.sent.length = 0;
	state.failures = 1;
	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

	expect(found?.user.email).toBe("rio@example.com");
	expect(state.sent).toHaveLength(2);
	expect(warned).toHaveBeenCalledTimes(1);
});

it("gives up on a read that keeps failing, and answers the next one", async () => {
	const { database, state } = faulty(real);
	const { auth, cookie } = await signedUp(database, "sol@example.com");

	state.sent.length = 0;
	state.failures = READ_ATTEMPTS;
	await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).rejects.toThrow(
		"Failed to get session",
	);
	expect(state.sent).toHaveLength(READ_ATTEMPTS);

	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });
	expect(found?.user.email).toBe("sol@example.com");
});

describe("which failures are sent again", () => {
	// The texts Cloudflare's D1 error list answers with "Retry the operation", as D1 words them,
	// and the local runtime's.
	it.each([
		["connection-lost", "D1_ERROR: Network connection lost."],
		["storage-reset", "D1_ERROR: Internal error in D1 DB storage caused object to be reset."],
		[
			"storage-reset",
			"D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
		],
		["code-updated", "D1_ERROR: D1 DB reset because its code was updated."],
		["replica-disconnected", "D1_ERROR: Replica disconnected from primary."],
		["cannot-resolve", "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node."],
		["local-commit-token", LOCAL],
	])("a passing one (%s), logged by that name", async (label, message) => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database, { random: () => 0 });
		state.failures = 1;
		state.message = message;

		const rows = await d1.prepare("select ? as n").bind(7).all<{ n: number }>();

		expect(rows.results[0]?.n).toBe(7);
		expect(state.sent).toHaveLength(2);
		expect(logged()).toBe(`d1: a read failed (${label}) and is sent again (attempt 1)`);
	});

	it.each([
		["an overloaded database", "D1_ERROR: D1 DB is overloaded. Requests queued for too long."],
		["a full queue", "D1_ERROR: D1 DB is overloaded. Too many requests queued."],
		["too much CPU", "D1_ERROR: D1 DB exceeded its CPU time limit and was reset."],
		["too much memory", "D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset."],
		[
			"a write that took too long",
			"D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
		],
		[
			"too large a result",
			"D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB",
		],
		["too many requests", "Too many API requests by single worker invocation."],
		// The list says to retry this one, but a resend cannot help a caller who left.
		["a caller who left", "D1_ERROR: Can't read from request stream because client disconnected."],
		["the wrong number of values", "D1_ERROR: Wrong number of parameter bindings for SQL query."],
		["a column that is not there", "D1_COLUMN_NOTFOUND: Column not found (missing)"],
		["one nobody knows", "D1_ERROR: something nobody has seen before"],
	])("not %s: thrown at once", async (_what, message) => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database, { random: () => 0 });
		state.failures = 1;
		state.message = message;

		await expect(d1.prepare("select 1").all()).rejects.toThrow(message);

		expect(state.sent).toHaveLength(1);
		expect(warned).not.toHaveBeenCalled();
	});

	it("not what SQLite refused, which it would refuse again", async () => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database);

		await expect(d1.prepare("select * from no_such_table").all()).rejects.toThrow("SQLITE_ERROR");

		expect(state.sent).toHaveLength(1);
		expect(warned).not.toHaveBeenCalled();
	});
});

it("logs nothing D1 said: its words can carry what a row held", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database, { random: () => 0 });
	const token = "kJ8sT0kEnT0kEnT0kEnT0kEnT0kEn";
	const address = "someone@example.com";
	state.failures = 1;
	// As workerd words a body it could not read, with a passing failure's text inside it.
	state.message = `D1_ERROR: Failed to parse body as JSON, got: {"token":"${token}","email":"${address}"} Network connection lost.`;

	await d1.prepare("select 1").all();

	expect(warned).toHaveBeenCalledTimes(1);
	expect(logged()).not.toContain(token);
	expect(logged()).not.toContain(address);
	expect(logged()).toBe("d1: a read failed (connection-lost) and is sent again (attempt 1)");
});

it("sends a write once: it may have happened although its answer was lost", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database);
	state.failures = 1;

	await expect(
		d1
			.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
			.bind("once", "once", "once", 1)
			.run(),
	).rejects.toThrow(LOCAL);

	expect(state.sent).toHaveLength(1);
	expect(warned).not.toHaveBeenCalled();
	// Sent again by hand, it is written once.
	await d1
		.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
		.bind("once", "once", "once", 1)
		.run();
	const rows = await d1.prepare("select id from verification where id = ?").bind("once").all();
	expect(rows.results).toHaveLength(1);
});

it("sends a select once when another statement follows it, which may write", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database);
	state.failures = 1;

	await expect(
		d1
			.prepare(
				"select 1; insert into verification (id, identifier, value, expires_at) values ('two', 'two', 'two', 1)",
			)
			.all(),
	).rejects.toThrow(LOCAL);

	expect(state.sent).toHaveLength(1);
	expect(warned).not.toHaveBeenCalled();
});

it("still sends again a select that only ends with a semicolon", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database, { random: () => 0 });
	state.failures = 1;

	const rows = await d1.prepare("select 3 as n;\n").all<{ n: number }>();

	expect(rows.results[0]?.n).toBe(3);
	expect(state.sent).toHaveLength(2);
});

it("leaves a batch to the database as it was given", async () => {
	const d1 = retryingReads(real);
	const [one, two] = await d1.batch<{ n: number }>([
		d1.prepare("select ? as n").bind(1),
		d1.prepare("select ? as n").bind(2),
	]);
	expect([one?.results[0]?.n, two?.results[0]?.n]).toEqual([1, 2]);
});

describe("a session of the database", () => {
	it("has its reads sent again too, and its writes once", async () => {
		const { database, state } = faulty(real);
		const session = retryingReads(database, { random: () => 0 }).withSession("first-primary");

		state.failures = 1;
		const rows = await session.prepare("select ? as n").bind(5).all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(5);
		expect(state.sent).toHaveLength(2);

		state.sent.length = 0;
		state.failures = 1;
		await expect(
			session
				.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
				.bind("in-session", "s", "s", 1)
				.run(),
		).rejects.toThrow(LOCAL);
		expect(state.sent).toHaveLength(1);
	});

	it("keeps its bookmark and its batch", async () => {
		const session = retryingReads(real).withSession("first-primary");
		const unwrapped = real.withSession("first-primary");
		expect(session.getBookmark()).toBe(unwrapped.getBookmark());

		const [one] = await session.batch<{ n: number }>([session.prepare("select ? as n").bind(9)]);
		expect(one?.results[0]?.n).toBe(9);

		await unwrapped.prepare("select 1").all();
		await session.prepare("select 1").all();
		expect(typeof session.getBookmark()).toBe(typeof unwrapped.getBookmark());
	});
});

// What ID asks of D1 that the builders' plain selects do not cover.
describe("ID's own statements", () => {
	it("sends again the reads it writes by hand, which begin with a line break and SELECT", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);

		const signUp = await signUpState(db);
		const allowed = await mayMakeAccount(db, "stranger@elsewhere.test");

		state.sent.length = 0;
		state.failures = 1;
		expect(await signUpState(db)).toBe(signUp);
		expect(state.sent).toHaveLength(2);

		state.sent.length = 0;
		state.failures = 2;
		expect(await mayMakeAccount(db, "stranger@elsewhere.test")).toBe(allowed);
		expect(state.sent).toHaveLength(3);
		expect(state.sent[0]).toMatch(/^\s+SELECT \(/);
	});

	it("sends once the daily run's delete, which begins with no select although it holds one", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;

		await expect(pruneExpired(db)).rejects.toBeInstanceOf(DatabaseError);

		expect(state.sent).toHaveLength(1);
		expect(state.sent[0]).toMatch(/^delete from "session" where "session"\."id" in \(select /);
		expect(warned).not.toHaveBeenCalled();
	});
});

// An authorization code, a sign-up code and a password reset's token are rows of `verification`,
// used up through Better Auth's `consumeVerificationValue`: it reads the newest row for the
// identifier, then deletes that row by its id and goes on only if the delete returned it. The
// read may be sent again. The delete is what decides, and is sent once.
describe("a code, which is good once", () => {
	async function withACode(identifier: string) {
		const { database, state } = faulty(real);
		const { auth } = authOn(database);
		const { internalAdapter } = await auth.$context;
		await internalAdapter.createVerificationValue({
			identifier,
			value: "what-the-code-stands-for",
			expiresAt: new Date(Date.now() + 60_000),
		});
		state.sent.length = 0;
		return { state, use: () => internalAdapter.consumeVerificationValue(identifier) };
	}

	const deletes = (sent: string[]) => sent.filter((query) => /^delete\b/i.test(query));

	it("is used once when the read before it failed for a moment", async () => {
		const { state, use } = await withACode("code-read-failed-once");

		state.failures = 1;
		const first = await use();

		expect(first?.value).toBe("what-the-code-stands-for");
		expect(warned).toHaveBeenCalledTimes(1);
		// The read twice, and the delete that decides once.
		expect(state.sent.filter((query) => /^select\b/i.test(query))).toHaveLength(2);
		expect(deletes(state.sent).filter((query) => / returning /.test(query))).toHaveLength(1);
		expect(await use()).toBeNull();
	});

	it("goes to one of two that ask together, with a read failing for each", async () => {
		const { state, use } = await withACode("code-asked-for-twice");

		state.only = /^select\b/i;
		state.failures = 2;
		const answers = await Promise.all([use(), use()]);

		expect(answers.filter(Boolean)).toHaveLength(1);
		expect(await use()).toBeNull();
	});

	it("is not used up by a delete that failed, which is sent once and not again", async () => {
		const { state, use } = await withACode("code-delete-failed");

		state.only = /^delete\b/i;
		state.failures = 1;
		await expect(use()).rejects.toBeInstanceOf(DatabaseError);

		expect(deletes(state.sent)).toHaveLength(1);
		expect(deletes(state.sent)[0]).toMatch(/^delete from "verification" .* returning /);
		expect(warned).not.toHaveBeenCalled();
		// D1 never got it, so the row is there for whoever asks next, once.
		expect((await use())?.value).toBe("what-the-code-stands-for");
		expect(await use()).toBeNull();
	});
});

// A refresh token is rotated by the adapter's `incrementOne`: one `update … returning` that only
// touches a row not yet revoked. Whoever's update returns the row gets the new token.
describe("a refresh token, which is rotated once", () => {
	it("has the update that decides sent once, although it returns rows", async () => {
		const { database, state } = faulty(real);
		const { auth } = await signedUp(database, "rotating@example.com");
		const { adapter } = await auth.$context;
		const app = appRow({
			app: "rotating-app",
			name: "Rotating App",
			redirectUris: ["https://rotating.apps.test/callback"],
		});
		await real.prepare(insertStatement(app.row)).run();
		const now = new Date();
		await createDb(real)
			.insert(schema.oauthRefreshToken)
			.values({
				id: "refresh-token-row",
				token: "a-made-up-hash-of-a-refresh-token",
				clientId: app.clientId,
				userId: "u-rotating@example.com",
				expiresAt: new Date(now.getTime() + 60_000),
				createdAt: now,
				scopes: ["openid"],
			});
		// As the provider rotates one.
		const rotate = () =>
			adapter.incrementOne({
				model: "oauthRefreshToken",
				where: [
					{ field: "id", value: "refresh-token-row" },
					{ field: "revoked", operator: "eq", value: null },
				],
				increment: {},
				set: { revoked: new Date(), rotatedAt: new Date() },
			});

		state.sent.length = 0;
		state.failures = 1;
		await expect(rotate()).rejects.toBeInstanceOf(DatabaseError);

		expect(state.sent).toHaveLength(1);
		expect(state.sent[0]).toMatch(/^update "oauth_refresh_token" set .* returning /);
		expect(warned).not.toHaveBeenCalled();
		// Not written, so the next one that asks gets it, and the one after that does not.
		expect(await rotate()).toMatchObject({ id: "refresh-token-row" });
		expect(await rotate()).toBeNull();
	});
});

// Every query of the Worker goes through this, so a read that works must cost what it did.
describe("a read that works", () => {
	it("is sent once, waits for nothing and logs nothing", async () => {
		const { database, state } = faulty(real);
		const waits: number[] = [];
		const d1 = retryingReads(database, {
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		await d1.prepare("select ? as n").bind(1).all();
		await d1.prepare("select ? as n").bind(1).first();
		await d1.prepare("select ? as n").bind(1).raw();

		expect(state.sent).toHaveLength(3);
		expect(waits).toEqual([]);
		expect(warned).not.toHaveBeenCalled();
	});

	it("is one statement for a session and its person, through Better Auth", async () => {
		const { database, state } = faulty(real);
		const { auth, cookie } = await signedUp(database, "uma@example.com");

		state.sent.length = 0;
		const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

		expect(found?.user.email).toBe("uma@example.com");
		expect(state.sent).toHaveLength(1);
	});
});

describe("the waits between attempts", () => {
	/** The waits a read that failed twice asked for, in milliseconds, without waiting them. */
	async function failingTwice(random: () => number) {
		const { database, state } = faulty(real);
		const waits: number[] = [];
		const d1 = retryingReads(database, {
			random,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});
		state.failures = 2;
		await d1.prepare("select 1").all();
		return waits;
	}

	it("are half as long at the least and half as long again at the most", async () => {
		expect(await failingTwice(() => 0)).toEqual([12.5, 50]);
		expect(await failingTwice(() => 0.5)).toEqual([25, 100]);
		expect(await failingTwice(() => 1)).toEqual([37.5, 150]);
	});

	it("differ from one read to the next", async () => {
		const drawn = [0.1, 0.9];
		expect(await failingTwice(() => drawn.shift() ?? 0)).toEqual([15, 140]);
	});
});
