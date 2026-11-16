import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "../db";
import { faulty, LOCAL, migratedD1 } from "../db/faulty-d1";
import { READ_ATTEMPTS } from "../db/retry-reads";
import { workspaceAppRow } from "./app-row";
import { type AuthConfig, createAuth } from "./config";

// The guards that read a request's session to decide, and leave a request with none to the
// endpoint: on changing a second factor, removing a password, counting password tries and
// answering for a workspace's app. Each refuses when a session cookie came and the session could
// not be read. See "When a guard cannot read the session" in docs/architecture.md.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("session-of-test"));
	// As the Worker tests do, so that a test can make people at will.
	await real.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
});

afterAll(async () => {
	await dispose?.();
});

beforeEach(() => {
	// A failed query is logged, by this app and by Better Auth, and these tests make many.
	for (const level of ["error", "warn", "info", "log", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation(() => {});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";
const baseURL = "https://id.test";

/** Only the read of a session, so that everything else a request asks is answered. */
const SESSION_READ = /^select .* from "session"/i;

/**
 * The two ways a read fails for the one who asked: a failure that passes, on every attempt it is
 * given, and one that is not sent again at all.
 */
const FAILED_READS: [how: string, failures: number, message: string][] = [
	["on every attempt it is given", READ_ATTEMPTS, LOCAL],
	["in a way that is not sent again", 1, "D1_ERROR: D1 DB is overloaded."],
];

let clients = 0;
/** Each request from an address of its own, so that no rate limit answers for a guard. */
const newClient = () => `203.0.113.${++clients % 250}`;

function authOn(d1: D1Database, settings: Partial<AuthConfig> = {}) {
	const db = createDb(d1);
	const auth = createAuth({
		db,
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL,
		oidc: { issuer: baseURL, pairwiseSecret: "a-test-secret-for-each-apps-own-ids" },
		...settings,
	});
	return { db, auth };
}

/**
 * Someone with a password and a session made with it alone, on a database that fails when told
 * to. Nobody signs up with a password here, so the rows are made.
 */
async function signedUp(email: string, settings: Partial<AuthConfig> = {}) {
	const { database, state } = faulty(real);
	const { db, auth } = authOn(database, settings);
	const id = `u-${email}`;
	const passwordRow = `a-${email}`;
	const now = new Date();
	await db
		.insert(schema.user)
		.values({ id, name: "Rio", email, emailVerified: true, createdAt: now, updatedAt: now });
	await db.insert(schema.account).values({
		id: passwordRow,
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
	return { id, email, passwordRow, db, auth, cookie, state };
}

type Person = Awaited<ReturnType<typeof signedUp>>;

async function send(
	person: Pick<Person, "auth">,
	path: string,
	{ cookie, body }: { cookie?: string | undefined; body?: object | undefined } = {},
) {
	const response = await person.auth.handler(
		new Request(`${baseURL}/api/auth${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				origin: baseURL,
				"cf-connecting-ip": newClient(),
				...(cookie && { cookie }),
				...(body && { "content-type": "application/json" }),
			},
			...(body && { body: JSON.stringify(body) }),
		}),
	);
	const text = await response.text();
	let answer: { code?: string; url?: string } = {};
	try {
		answer = JSON.parse(text) as typeof answer;
	} catch {}
	return { status: response.status, code: answer.code, url: answer.url, text };
}

/** Fails the next read of a session as told, and says afterwards whether one was failed. */
function failTheSessionRead({ state }: Person, failures: number, message: string) {
	state.only = SESSION_READ;
	state.failures = failures;
	state.message = message;
	return () => state.failures === 0;
}

/** Turns two-factor on for someone whose session was made before, so it showed one factor. */
async function withTwoFactor({ db, id }: Person) {
	await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, id));
	const row = {
		id: `tf-${id}`,
		userId: id,
		secret: "a-secret-nobody-reads-here",
		backupCodes: "the-codes-as-they-were",
	};
	await db.insert(schema.twoFactor).values(row);
	return row;
}

async function withPasskey({ db, id }: Person) {
	const row = {
		id: `pk-${id}`,
		userId: id,
		name: "A key",
		publicKey: "a-public-key",
		credentialID: `credential-${id}`,
		counter: 0,
		deviceType: "singleDevice",
		backedUp: false,
		createdAt: new Date(),
	};
	await db.insert(schema.passkey).values(row);
	return row;
}

/** A second way in, so that a password is not the last one and could be removed. */
async function withGitHub({ db, id }: Person) {
	const now = new Date();
	await db.insert(schema.account).values({
		id: `gh-${id}`,
		accountId: `github-${id}`,
		providerId: "github",
		userId: id,
		createdAt: now,
		updatedAt: now,
	});
}

async function twoFactorOf({ db, id }: Person) {
	const [person, rows] = await Promise.all([
		db
			.select({ on: schema.user.twoFactorEnabled })
			.from(schema.user)
			.where(eq(schema.user.id, id))
			.get(),
		db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, id)).all(),
	]);
	return { on: person?.on, rows };
}

const passkeysOf = ({ db, id }: Person) =>
	db
		.select({ id: schema.passkey.id })
		.from(schema.passkey)
		.where(eq(schema.passkey.userId, id))
		.all();

async function passwordOf({ db, passwordRow }: Person) {
	const row = await db
		.select({ password: schema.account.password })
		.from(schema.account)
		.where(eq(schema.account.id, passwordRow))
		.get();
	return row?.password ?? undefined;
}

const sessionsOf = ({ db, id }: Person) =>
	db
		.select({ id: schema.session.id })
		.from(schema.session)
		.where(eq(schema.session.userId, id))
		.all();

describe.each(FAILED_READS)("when the read of a session fails %s", (_how, failures, message) => {
	it("two-factor is not turned off", async () => {
		const person = await signedUp(`off-${failures}@guards.test`);
		const row = await withTwoFactor(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		expect(await twoFactorOf(person)).toMatchObject({ on: true, rows: [row] });
		// And the session it came with is the one there still is.
		expect(await sessionsOf(person)).toHaveLength(1);
	});

	it("the recovery codes are not replaced", async () => {
		const person = await signedUp(`codes-${failures}@guards.test`);
		const row = await withTwoFactor(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/two-factor/generate-backup-codes", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("backupCodes");
		expect(failed()).toBe(true);
		expect(await twoFactorOf(person)).toMatchObject({ on: true, rows: [row] });
	});

	it("an authenticator is not begun", async () => {
		const person = await signedUp(`begin-${failures}@guards.test`);
		const key = await withPasskey(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("totpURI");
		expect(failed()).toBe(true);
		expect(await twoFactorOf(person)).toMatchObject({ rows: [] });
		expect(await passkeysOf(person)).toEqual([{ id: key.id }]);
	});

	it("no passkey is begun", async () => {
		const person = await signedUp(`options-${failures}@guards.test`);
		await withTwoFactor(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/passkey/generate-register-options", {
			cookie: person.cookie,
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("challenge");
		expect(failed()).toBe(true);
		expect(await passkeysOf(person)).toEqual([]);
	});

	it("a passkey is not removed", async () => {
		const person = await signedUp(`remove-${failures}@guards.test`);
		const key = await withPasskey(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/account/remove-passkey", {
			cookie: person.cookie,
			body: { id: key.id },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		expect(await passkeysOf(person)).toEqual([{ id: key.id }]);
	});

	it("a password is not removed without the password", async () => {
		const person = await signedUp(`unlink-${failures}@guards.test`);
		await withGitHub(person);
		const before = await passwordOf(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/unlink-account", {
			cookie: person.cookie,
			body: { accountId: person.passwordRow },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		expect(before).toBeTruthy();
		expect(await passwordOf(person)).toBe(before);
	});

	it("a password is not tried past what a person's sessions may try", async () => {
		const asked: string[] = [];
		const person = await signedUp(`tries-${failures}@guards.test`, {
			allowPasswordTry: async (userId) => {
				asked.push(userId);
				return false;
			},
		});
		const before = await passwordOf(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		// Nobody was named to count against, and the password is what it was.
		expect(asked).toEqual([]);
		expect(await passwordOf(person)).toBe(before);
		expect(await verifyPassword({ hash: before ?? "", password: PASSWORD })).toBe(true);
	});

	it("nobody is answered for a workspace's app as if they might be a member", async () => {
		const owner = await signedUp(`owner-${failures}@guards.test`);
		const stranger = await signedUp(`stranger-${failures}@guards.test`);
		const app = await workspaceAppOf(owner, `guards-${failures}`);
		const failed = failTheSessionRead(stranger, failures, message);

		const answer = await send(stranger, "/oauth2/consent", {
			cookie: stranger.cookie,
			body: { accept: true, oauth_query: `client_id=${app}` },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
	});
});

async function workspaceAppOf(owner: Person, slug: string) {
	const made = await owner.auth.api.createOrganization({
		body: { name: slug, slug },
		headers: new Headers({ cookie: owner.cookie, origin: baseURL }),
	});
	const { row, clientId } = workspaceAppRow({
		workspace: made.id,
		name: "Notes",
		redirectUris: [`https://${slug}.test/callback`],
		addedBy: owner.id,
	});
	const columns = Object.keys(row);
	await real
		.prepare(
			`INSERT INTO "oauth_client" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.bind(...Object.values(row))
		.run();
	return clientId;
}

describe("when the session cannot be read at all", () => {
	it("a guard answers 500, and so does the endpoint behind it", async () => {
		const person = await signedUp("gone@guards.test");
		const row = await withTwoFactor(person);
		person.state.only = SESSION_READ;
		person.state.failures = 100;

		const answer = await send(person, "/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(await twoFactorOf(person)).toMatchObject({ on: true, rows: [row] });
	});
});

// What the guards did before, and still do: with the database answering, a session decides, and
// someone with no session gets the endpoint's own answer.
describe("when the database answers", () => {
	it("a session that showed one factor is refused as it was, and reads its session once", async () => {
		const person = await signedUp("one-factor@guards.test");
		const row = await withTwoFactor(person);
		const key = await withPasskey(person);
		person.state.sent.length = 0;

		const off = await send(person, "/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(off).toMatchObject({ status: 403, code: "TWO_FACTORS_TO_CHANGE_TWO_FACTOR" });
		expect(person.state.sent.filter((query) => SESSION_READ.test(query))).toHaveLength(1);
		const codes = await send(person, "/two-factor/generate-backup-codes", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(codes).toMatchObject({ status: 403, code: "TWO_FACTORS_TO_CHANGE_TWO_FACTOR" });
		const options = await send(person, "/passkey/generate-register-options", {
			cookie: person.cookie,
		});
		expect(options).toMatchObject({ status: 403, code: "TWO_FACTORS_TO_ADD_A_PASSKEY" });
		const removed = await send(person, "/account/remove-passkey", {
			cookie: person.cookie,
			body: { id: key.id },
		});
		expect(removed).toMatchObject({ status: 403, code: "TWO_FACTORS_TO_REMOVE_A_PASSKEY" });
		expect(await twoFactorOf(person)).toMatchObject({ on: true, rows: [row] });
		expect(await passkeysOf(person)).toEqual([{ id: key.id }]);
	});

	it("a password is not removed without the password, and is with it", async () => {
		const person = await signedUp("unlink@guards.test");
		await withGitHub(person);

		const without = await send(person, "/unlink-account", {
			cookie: person.cookie,
			body: { accountId: person.passwordRow },
		});
		expect(without).toMatchObject({ status: 400, code: "INVALID_PASSWORD" });
		expect(await passwordOf(person)).toBeTruthy();

		const withIt = await send(person, "/unlink-account", {
			cookie: person.cookie,
			body: { accountId: person.passwordRow, password: PASSWORD },
		});
		expect(withIt.status).toBe(200);
		expect(await passwordOf(person)).toBeUndefined();
	});

	it("a person whose tries are spent is told so", async () => {
		const person = await signedUp("spent@guards.test", { allowPasswordTry: async () => false });

		const answer = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(answer).toMatchObject({ status: 429, code: "TOO_MANY_PASSWORD_TRIES" });
	});

	it("someone who is no member is sent away from a workspace's app, and a member is not", async () => {
		const owner = await signedUp("owner@guards.test");
		const stranger = await signedUp("stranger@guards.test");
		const app = await workspaceAppOf(owner, "guards");
		const body = { accept: true, oauth_query: `client_id=${app}` };

		const refused = await send(stranger, "/oauth2/consent", { cookie: stranger.cookie, body });
		expect(refused).toMatchObject({ status: 200, url: "/no-access" });

		const member = await send(owner, "/oauth2/consent", { cookie: owner.cookie, body });
		expect(member.url).not.toBe("/no-access");
	});

	it.each([
		["/two-factor/disable", { password: PASSWORD }],
		["/two-factor/generate-backup-codes", { password: PASSWORD }],
		["/passkey/generate-register-options", undefined],
		["/account/remove-passkey", { id: "any" }],
		["/unlink-account", { accountId: "any" }],
		["/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }],
	])("someone with no cookie gets the endpoint's own answer: %s", async (path, body) => {
		const { database, state } = faulty(real);
		const { auth } = authOn(database, { allowPasswordTry: async () => false });
		state.sent.length = 0;

		const answer = await send({ auth }, path, { body });

		expect(answer.status).toBe(401);
		// Nobody to look up: the guards ask the database nothing.
		expect(state.sent.filter((query) => SESSION_READ.test(query))).toEqual([]);
	});

	it("someone whose session has gone gets the endpoint's own answer", async () => {
		const person = await signedUp("signed-out@guards.test", {
			allowPasswordTry: async () => false,
		});
		await withTwoFactor(person);
		await person.db.delete(schema.session).where(eq(schema.session.userId, person.id));

		const off = await send(person, "/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		const unlink = await send(person, "/unlink-account", {
			cookie: person.cookie,
			body: { accountId: person.passwordRow },
		});

		expect(off.status).toBe(401);
		expect(unlink.status).toBe(401);
		expect(await twoFactorOf(person)).toMatchObject({ on: true });
	});

	it("someone whose session has ended gets the endpoint's own answer", async () => {
		const person = await signedUp("ended@guards.test");
		await withTwoFactor(person);
		await person.db
			.update(schema.session)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(schema.session.userId, person.id));

		const off = await send(person, "/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(off.status).toBe(401);
		expect(await twoFactorOf(person)).toMatchObject({ on: true });
	});
});
