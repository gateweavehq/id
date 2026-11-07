import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type GitHubPerson,
	gitHubCode,
	PWNED_PASSWORDS,
	type SentEmail,
	startId,
} from "./id-worker";
import { totp } from "./totp";

// Who owns a deployment and who may make an account on it, through the public routes of the built
// Worker. What this protects is in "Who owns a deployment" in docs/architecture.md.

const origin = "https://id.test";

const CODE_EMAIL = "is your Gateweave ID code";
const EXISTS_EMAIL = "You already have a Gateweave ID account";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PASSWORD = "a-long-password-for-tests";
/** Lowercases to a plain k. */
const KELVIN = "\u212A";
/** `SIGN_UP_CODES_PER_ADDRESS` in src/server/rate-limit/index.ts. */
const SIGN_UP_CODES_AN_HOUR = 5;

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { github: true, newDeployment: true });
});

afterAll(async () => {
	await id?.dispose();
});

/** Each test starts on a server nobody has used. */
function startOver(db: typeof id.db) {
	return db.batch(
		[
			"UPDATE deployment SET owner_id = NULL WHERE id = 1",
			"DELETE FROM organization",
			"DELETE FROM user",
			"DELETE FROM deployment_invitation",
			"DELETE FROM verification",
			`INSERT OR REPLACE INTO deployment (id, owner_id, sign_up, updated_at)
				VALUES (1, NULL, 'closed', 0)`,
		].map((statement) => db.prepare(statement)),
	);
}

beforeEach(async () => {
	await startOver(id.db);
});

let clients = 0;
let addresses = 0;
let gitHubIds = 5000;

function newClient() {
	const client = ++clients;
	return `203.0.${Math.floor(client / 250)}.${(client % 250) + 1}`;
}

/** Codes and invitations are capped per address, and the outbox keeps every test's mail. */
function newAddress() {
	return `person-${++addresses}@example.com`;
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0] ?? "")
		.filter((cookie) => !cookie.endsWith("="))
		.join("; ");
}

function post(path: string, body: object, cookie?: string) {
	return id.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

function requestCode(email: string) {
	return post("/email-otp/send-verification-otp", { email, type: "sign-in" });
}

function enterCode(email: string, otp: string) {
	return post("/sign-in/email-otp", { email, otp, name: "A Person" });
}

async function emailsTo(address: string, subject: string): Promise<SentEmail[]> {
	return (await id.emails()).filter(
		(sent) => sent.to === address && sent.subject.includes(subject),
	);
}

/** Email is sent after the response, so wait for it to arrive. */
async function emailTo(address: string, subject: string): Promise<SentEmail> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const [found] = await emailsTo(address, subject);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No email to ${address} about "${subject}"`);
}

async function codeFor(address: string) {
	const code = /\b\d{6}\b/.exec((await emailTo(address, CODE_EMAIL)).text)?.[0];
	if (!code) throw new Error("No code in the email");
	return code;
}

/** Asks for a code and uses it. Returns who that made, and their cookie. */
async function signUp(email: string) {
	expect((await requestCode(email)).status).toBe(200);
	const signedUp = await enterCode(email, await codeFor(email));
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.json()) as { user: { id: string } };
	return { userId: user.id, cookie: cookieOf(signedUp) };
}

async function theDeployment() {
	return id.db
		.prepare("SELECT owner_id AS ownerId, sign_up AS signUp FROM deployment WHERE id = 1")
		.first<{ ownerId: string | null; signUp: string }>();
}

async function accountsWith(email: string) {
	const row = await id.db
		.prepare("SELECT COUNT(*) AS accounts FROM user WHERE email = ?")
		.bind(email)
		.first<{ accounts: number }>();
	return row?.accounts;
}

async function codesStoredFor(email: string) {
	const row = await id.db
		.prepare("SELECT COUNT(*) AS codes FROM verification WHERE identifier LIKE ?")
		.bind(`%${email}%`)
		.first<{ codes: number }>();
	return row?.codes;
}

/** The owner vouching for an address, with no link to go with it, for what is not about the link. */
async function ownerInvites(email: string, expiresAt = Date.now() + HOUR) {
	const owner = (await theDeployment())?.ownerId;
	if (!owner) throw new Error("No owner to invite anyone");
	await id.db
		.prepare(
			`INSERT INTO deployment_invitation (id, email, token_hash, invited_by, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(crypto.randomUUID(), email, crypto.randomUUID(), owner, expiresAt, Date.now())
		.run();
}

/** As only something outside the app could: a row with no hook in front of it. */
function insertAccount(email: string, userId = crypto.randomUUID()) {
	const now = Date.now();
	return id.db
		.prepare(
			`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
				VALUES (?, 'By Hand', ?, 1, ?, ?)`,
		)
		.bind(userId, email, now, now)
		.run();
}

async function refused(response: Response, code: string, status = 403) {
	expect(response.status).toBe(status);
	expect(((await response.json()) as { code: string }).code).toBe(code);
}

async function makeWorkspace(cookie: string, slug: string) {
	return post("/organization/create", { name: "Acme", slug }, cookie);
}

async function canCreate(cookie: string) {
	const response = await id.fetch(`${origin}/api/auth/workspaces/list`, {
		headers: { "cf-connecting-ip": newClient(), cookie },
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { canCreate: boolean }).canCreate;
}

describe("a new deployment", () => {
	it("belongs to its first account, and closes behind it", async () => {
		expect(await theDeployment()).toEqual({ ownerId: null, signUp: "closed" });
		const { userId } = await signUp(newAddress());
		expect(await theDeployment()).toEqual({ ownerId: userId, signUp: "closed" });

		const stranger = newAddress();
		expect((await requestCode(stranger)).status).toBe(200);
		expect(await codesStoredFor(stranger)).toBe(0);
	});

	it("answers a stranger as it answers someone invited, and sends them nothing", async () => {
		await signUp(newAddress());
		const invited = newAddress();
		const stranger = newAddress();
		await ownerInvites(invited);

		const toStranger = await requestCode(stranger);
		const toInvited = await requestCode(invited);
		expect(toStranger.status).toBe(toInvited.status);
		expect(await toStranger.json()).toEqual(await toInvited.json());

		// The mail that does go out went after the stranger's would have.
		await codeFor(invited);
		expect(await codesStoredFor(invited)).toBe(1);
		expect(await codesStoredFor(stranger)).toBe(0);
		expect((await id.emails()).filter((sent) => sent.to === stranger)).toEqual([]);
	});

	it("asks about an address written with what only lowercases to a letter of it", async () => {
		await signUp(newAddress());
		const stranger = `k-${newAddress()}`;
		const invited = `k-${newAddress()}`;
		await ownerInvites(invited);

		expect((await requestCode(stranger.replace("k", KELVIN))).status).toBe(200);
		expect((await requestCode(invited.replace("k", KELVIN))).status).toBe(200);

		// The mail that does go out went after the stranger's would have.
		await codeFor(invited);
		expect(await codesStoredFor(stranger)).toBe(0);
		expect((await id.emails()).filter((sent) => sent.to === stranger)).toEqual([]);
	});

	it("counts an address written that way against its cap on codes", async () => {
		await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		const email = `k-${newAddress()}`;
		// All of them: a new code is a new row beside the old ones, and the newest is what counts.
		const storedCodes = async () => {
			const { results } = await id.db
				.prepare("SELECT value FROM verification WHERE identifier LIKE ?")
				.bind(`%${email}%`)
				.all<{ value: string }>();
			return results.map(({ value }: { value: string }) => value).sort();
		};

		await Promise.all(Array.from({ length: SIGN_UP_CODES_AN_HOUR }, () => requestCode(email)));
		const before = await storedCodes();
		expect(before).not.toEqual([]);

		// A new code would reset the attempts, which is what the cap is there to stop.
		expect((await requestCode(email.replace("k", KELVIN))).status).toBe(200);
		expect(await storedCodes()).toEqual(before);
	});

	it("still tells an address with an account so", async () => {
		const owner = newAddress();
		await signUp(owner);
		expect((await requestCode(owner)).status).toBe(200);
		await emailTo(owner, EXISTS_EMAIL);
	});

	it("lets someone invited in, however they type their address, once", async () => {
		await signUp(newAddress());
		const invited = newAddress();
		await ownerInvites(invited);

		const typed = invited.toUpperCase();
		expect((await requestCode(typed)).status).toBe(200);
		const signedUp = await enterCode(typed, await codeFor(invited));
		expect(signedUp.status).toBe(200);
		expect(await accountsWith(invited)).toBe(1);

		const left = await id.db
			.prepare("SELECT COUNT(*) AS invitations FROM deployment_invitation WHERE email = ?")
			.bind(invited)
			.first<{ invitations: number }>();
		expect(left?.invitations).toBe(0);
	});

	it("does not count a stranger's asking against an address invited later", async () => {
		await signUp(newAddress());
		const later = newAddress();
		for (let asked = 0; asked < 12; asked++) await requestCode(later);
		await ownerInvites(later);

		expect((await requestCode(later)).status).toBe(200);
		await codeFor(later);
	});

	it("refuses a right code when the invitation has gone in the meantime", async () => {
		await signUp(newAddress());
		const invited = newAddress();
		await ownerInvites(invited);
		expect((await requestCode(invited)).status).toBe(200);
		const code = await codeFor(invited);
		await id.db.prepare("DELETE FROM deployment_invitation WHERE email = ?").bind(invited).run();

		const response = await enterCode(invited, code);
		expect(cookieOf(response)).not.toContain("session_token");
		await refused(response, "SIGN_UP_CLOSED");
		expect(await accountsWith(invited)).toBe(0);
	});

	it("refuses the second of two who asked while it had no accounts", async () => {
		const first = newAddress();
		const second = newAddress();
		expect((await requestCode(first)).status).toBe(200);
		expect((await requestCode(second)).status).toBe(200);
		const secondCode = await codeFor(second);

		expect((await enterCode(first, await codeFor(first))).status).toBe(200);
		await refused(await enterCode(second, secondCode), "SIGN_UP_CLOSED");
		expect(await accountsWith(second)).toBe(0);
	});

	it("does not take an owner's invitation that has run out", async () => {
		await signUp(newAddress());
		const late = newAddress();
		await ownerInvites(late, Date.now() - 1000);

		await requestCode(late);
		expect(await codesStoredFor(late)).toBe(0);
		await expect(insertAccount(late)).rejects.toThrow("sign-up is closed here");
	});

	it("takes a workspace's invitation as a way in until it is withdrawn", async () => {
		const { cookie } = await signUp(newAddress());
		const made = await makeWorkspace(cookie, "open-door");
		expect(made.status).toBe(200);
		const { id: organizationId } = (await made.json()) as { id: string };

		const staying = newAddress();
		const invited = await post(
			"/organization/invite-member",
			{ organizationId, email: staying, role: "member" },
			cookie,
		);
		expect(invited.status).toBe(200);
		const leaving = newAddress();
		const withdrawn = await post(
			"/organization/invite-member",
			{ organizationId, email: leaving, role: "member" },
			cookie,
		);
		const { id: invitationId } = (await withdrawn.json()) as { id: string };
		expect((await post("/organization/cancel-invitation", { invitationId }, cookie)).status).toBe(
			200,
		);

		await requestCode(leaving);
		expect(await codesStoredFor(leaving)).toBe(0);
		await expect(insertAccount(leaving)).rejects.toThrow("sign-up is closed here");

		const signedUp = await signUp(staying);
		expect(signedUp.cookie).toContain("session_token");
	});

	it("does not take a workspace's invitation that has run out", async () => {
		const { cookie } = await signUp(newAddress());
		const made = await makeWorkspace(cookie, "old-door");
		const { id: organizationId } = (await made.json()) as { id: string };
		const late = newAddress();
		await post(
			"/organization/invite-member",
			{ organizationId, email: late, role: "member" },
			cookie,
		);
		await id.db
			.prepare("UPDATE invitation SET expires_at = ? WHERE email = ?")
			.bind(Date.now() - 1000, late)
			.run();

		await requestCode(late);
		expect(await codesStoredFor(late)).toBe(0);
		await expect(insertAccount(late)).rejects.toThrow("sign-up is closed here");
	});

	it("takes anyone at all once the owner opens it", async () => {
		await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		await signUp(newAddress());
	});

	it("stays shut if its row has gone", async () => {
		const { cookie } = await signUp(newAddress());
		await id.db.prepare("DELETE FROM deployment").run();

		const stranger = newAddress();
		await requestCode(stranger);
		expect(await codesStoredFor(stranger)).toBe(0);
		await expect(insertAccount(stranger)).rejects.toThrow("sign-up is closed here");
		await refused(await makeWorkspace(cookie, "no-row"), "ONLY_THE_OWNER_MAKES_WORKSPACES");
		expect(await canCreate(cookie)).toBe(false);
	});
});

describe("the time an answer about an address takes", () => {
	const timedOrigin = "https://timed.test";
	/** What the code in src/server/auth/even-answer.ts holds to, less what a timer may round off. */
	const FLOOR = 995;
	let timed: Awaited<ReturnType<typeof startId>>;

	beforeAll(async () => {
		timed = await startId(timedOrigin, { newDeployment: true, settings: { ANSWER_FLOOR_MS: "" } });
	});

	afterAll(async () => {
		await timed?.dispose();
	});

	async function timeOf(path: string, body: object) {
		const started = performance.now();
		const response = await timed.fetch(`${timedOrigin}/api/auth${path}`, {
			method: "POST",
			headers: {
				origin: timedOrigin,
				"cf-connecting-ip": newClient(),
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		await response.arrayBuffer();
		return { status: response.status, took: performance.now() - started };
	}

	/** A first account, so that the server is closed and there is someone to tell from a stranger. */
	async function firstAccount() {
		const email = newAddress();
		await timed.db.batch(
			["UPDATE deployment SET owner_id = NULL WHERE id = 1", "DELETE FROM user"].map((statement) =>
				timed.db.prepare(statement),
			),
		);
		expect(
			(await timeOf("/email-otp/send-verification-otp", { email, type: "sign-in" })).status,
		).toBe(200);
		let code: string | undefined;
		for (let attempt = 0; attempt < 100 && !code; attempt++) {
			const found = (await timed.emails()).find(
				(sent) => sent.to === email && sent.subject.includes(CODE_EMAIL),
			);
			code = found && /\b\d{6}\b/.exec(found.text)?.[0];
			if (!code) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(
			(await timeOf("/sign-in/email-otp", { email, otp: code, name: "A Person" })).status,
		).toBe(200);
		return email;
	}

	it("is no shorter for a stranger than for an address with an account, asking for one", async () => {
		const owner = await firstAccount();
		for (const email of [owner, newAddress()]) {
			const { status, took } = await timeOf("/email-otp/send-verification-otp", {
				email,
				type: "sign-in",
			});
			expect(status).toBe(200);
			expect(took).toBeGreaterThanOrEqual(FLOOR);
		}
	});

	it("is no shorter for a stranger than for an address with an account, entering a wrong one", async () => {
		const owner = await firstAccount();
		for (const email of [owner, newAddress()]) {
			const { status, took } = await timeOf("/sign-in/email-otp", {
				email,
				otp: "000000",
				name: "A Person",
			});
			expect(status).toBe(400);
			expect(took).toBeGreaterThanOrEqual(FLOOR);
		}
	});

	it("is no shorter for a stranger than for an address with an account, resetting a password", async () => {
		const owner = await firstAccount();
		for (const email of [owner, newAddress()]) {
			const { status, took } = await timeOf("/request-password-reset", {
				email,
				redirectTo: "/reset-password",
			});
			expect(status).toBe(200);
			expect(took).toBeGreaterThanOrEqual(FLOOR);
		}
	});

	// The floor is on the exact path. Were one of these ever to reach the same code, it would have none.
	it.each([
		"/request-password-reset/",
		"/REQUEST-PASSWORD-RESET",
		"/email-otp/send-verification-otp/",
		"/email-otp/send%2Dverification%2Dotp",
		"/EMAIL-OTP/send-verification-otp",
		"//email-otp/send-verification-otp",
	])("has no other way in by writing the path as %s", async (path) => {
		const { status } = await timeOf(path, { email: newAddress(), type: "sign-in" });
		expect(status).toBe(404);
	});
});

describe("the database, whatever makes an account", () => {
	it("refuses one with no way in, and takes one with", async () => {
		await signUp(newAddress());
		const stranger = newAddress();
		await expect(insertAccount(stranger)).rejects.toThrow("sign-up is closed here");
		expect(await accountsWith(stranger)).toBe(0);

		await ownerInvites(stranger);
		await insertAccount(stranger);
		expect(await accountsWith(stranger)).toBe(1);

		const left = await id.db
			.prepare("SELECT COUNT(*) AS invitations FROM deployment_invitation")
			.first<{ invitations: number }>();
		expect(left?.invitations).toBe(0);
	});

	it("lets one first account in when two try at once, and that one owns the server", async () => {
		const tries = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		const results = await Promise.allSettled(
			tries.map((userId) => insertAccount(newAddress(), userId)),
		);
		const made = tries.filter((_, index) => results[index]?.status === "fulfilled");
		expect(made).toHaveLength(1);
		expect((await theDeployment())?.ownerId).toBe(made[0]);
	});

	it("keeps the owner when others come", async () => {
		const { userId } = await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		await signUp(newAddress());
		expect((await theDeployment())?.ownerId).toBe(userId);
	});

	it("keeps its owner's account, however a request comes to delete it", async () => {
		const { userId } = await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		const { userId: other } = await signUp(newAddress());
		await expect(id.db.prepare("DELETE FROM user WHERE id = ?").bind(userId).run()).rejects.toThrow(
			/must keep its owner/,
		);
		expect((await theDeployment())?.ownerId).toBe(userId);

		// Once someone else runs it, it is an account like any other.
		await id.db.prepare("UPDATE deployment SET owner_id = ? WHERE id = 1").bind(other).run();
		await id.db.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
		expect((await theDeployment())?.ownerId).toBe(other);
	});

	it("gives nobody the place of an owner it has lost, while others remain", async () => {
		await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET owner_id = NULL WHERE id = 1").run();

		await signUp(newAddress());
		expect((await theDeployment())?.ownerId).toBeNull();
	});

	it("holds one row, saying closed or open", async () => {
		await expect(
			id.db.prepare("INSERT INTO deployment (id, sign_up, updated_at) VALUES (2, 'open', 0)").run(),
		).rejects.toThrow("deployment_one_row");
		await expect(
			id.db.prepare("UPDATE deployment SET sign_up = 'perhaps' WHERE id = 1").run(),
		).rejects.toThrow("deployment_sign_up");
	});
});

function person(email: string): GitHubPerson {
	const number = ++gitHubIds;
	return {
		id: number,
		login: `person-${number}`,
		name: "Grace Hopper",
		emails: [{ email, primary: true, verified: true }],
	};
}

async function signInAs(someone: GitHubPerson, server = id, at = origin) {
	const client = newClient();
	const started = await server.fetch(`${at}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin: at, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "/account" }),
	});
	expect(started.status).toBe(200);
	const { url } = (await started.json()) as { url: string };
	const query = new URLSearchParams({
		code: gitHubCode(someone),
		state: new URL(url).searchParams.get("state") ?? "",
	});
	return server.fetch(`${at}/api/auth/callback/github?${query}`, {
		headers: { "cf-connecting-ip": client, cookie: cookieOf(started) },
	});
}

function expectIn(response: Response) {
	expect(response.status).toBe(302);
	expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/account");
	expect(cookieOf(response)).toContain("session_token");
}

describe("GitHub on a new deployment", () => {
	it("gives the server to the first person, who can come back", async () => {
		const first = person(newAddress());
		expectIn(await signInAs(first));
		expect((await theDeployment())?.ownerId).toEqual(expect.any(String));
		expectIn(await signInAs(first));
	});

	it("sends a stranger back with the reason, and no account", async () => {
		await signUp(newAddress());
		const email = newAddress();
		const response = await signInAs(person(email));
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "", origin);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(cookieOf(response)).not.toContain("session_token");
		expect(await accountsWith(email)).toBe(0);
	});

	it("lets someone invited in", async () => {
		await signUp(newAddress());
		const email = newAddress();
		await ownerInvites(email);
		expectIn(await signInAs(person(email)));
		expect(await accountsWith(email)).toBe(1);
	});
});

describe("making workspaces", () => {
	it("is for the owner of a closed server", async () => {
		const owner = await signUp(newAddress());
		const invited = newAddress();
		await ownerInvites(invited);
		const member = await signUp(invited);

		expect(await canCreate(owner.cookie)).toBe(true);
		expect(await canCreate(member.cookie)).toBe(false);
		await refused(
			await makeWorkspace(member.cookie, "not-theirs"),
			"ONLY_THE_OWNER_MAKES_WORKSPACES",
		);
		expect((await makeWorkspace(owner.cookie, "theirs")).status).toBe(200);
	});

	it("is for anyone on an open one", async () => {
		await signUp(newAddress());
		const invited = newAddress();
		await ownerInvites(invited);
		const member = await signUp(invited);
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();

		expect(await canCreate(member.cookie)).toBe(true);
		expect((await makeWorkspace(member.cookie, "now-theirs")).status).toBe(200);
	});
});

describe("a workspace's invitations on a closed server", () => {
	/** Someone else's workspace, made while sign-up was open. It is left open for the test to close. */
	async function someoneElsesWorkspace() {
		const owner = await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		const admin = await signUp(newAddress());
		const made = await makeWorkspace(admin.cookie, "someone-elses");
		expect(made.status).toBe(200);
		const { id: organizationId } = (await made.json()) as { id: string };
		return { owner, admin, organizationId };
	}

	function closeSignUp() {
		return id.db.prepare("UPDATE deployment SET sign_up = 'closed' WHERE id = 1").run();
	}

	function invite(cookie: string, organizationId: string, email: string, role = "member") {
		return post("/organization/invite-member", { organizationId, email, role }, cookie);
	}

	function addMember(organizationId: string, userId: string, role: string) {
		return id.db
			.prepare(
				`INSERT INTO member (id, organization_id, user_id, role, created_at)
					VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(crypto.randomUUID(), organizationId, userId, role, Date.now())
			.run();
	}

	async function mayInvite(cookie: string, slug: string) {
		const response = await id.fetch(`${origin}/api/auth/workspaces/get?slug=${slug}`, {
			headers: { "cf-connecting-ip": newClient(), cookie },
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { mayInvite: boolean }).mayInvite;
	}

	it("let nobody in from a workspace the owner does not run, once sign-up closes", async () => {
		const { admin, organizationId } = await someoneElsesWorkspace();
		const sentWhileOpen = newAddress();
		expect((await invite(admin.cookie, organizationId, sentWhileOpen)).status).toBe(200);
		expect(await mayInvite(admin.cookie, "someone-elses")).toBe(true);

		await closeSignUp();

		const after = newAddress();
		await refused(await invite(admin.cookie, organizationId, after), "WORKSPACE_CANNOT_INVITE");
		expect(await mayInvite(admin.cookie, "someone-elses")).toBe(false);
		for (const email of [sentWhileOpen, after]) {
			await requestCode(email);
			expect(await codesStoredFor(email)).toBe(0);
			await expect(insertAccount(email)).rejects.toThrow("sign-up is closed here");
		}
	});

	it("tell an admin nothing about who has an account", async () => {
		const { admin, organizationId } = await someoneElsesWorkspace();
		const hasOne = newAddress();
		await signUp(hasOne);
		await closeSignUp();
		await refused(await invite(admin.cookie, organizationId, hasOne), "WORKSPACE_CANNOT_INVITE");
		await refused(
			await invite(admin.cookie, organizationId, newAddress()),
			"WORKSPACE_CANNOT_INVITE",
		);
	});

	it("still reach someone with an account, if sent while it was open", async () => {
		const { admin, organizationId } = await someoneElsesWorkspace();
		const email = newAddress();
		const person = await signUp(email);
		const sent = await invite(admin.cookie, organizationId, email);
		const { id: invitationId } = (await sent.json()) as { id: string };
		await closeSignUp();

		const accepted = await post("/organization/accept-invitation", { invitationId }, person.cookie);
		expect(accepted.status).toBe(200);
	});

	it("let someone in from a workspace the owner runs, and from an admin of theirs", async () => {
		const owner = await signUp(newAddress());
		const made = await makeWorkspace(owner.cookie, "the-owners");
		const { id: organizationId } = (await made.json()) as { id: string };
		expect(await mayInvite(owner.cookie, "the-owners")).toBe(true);

		const adminEmail = newAddress();
		const sent = await invite(owner.cookie, organizationId, adminEmail, "admin");
		expect(sent.status).toBe(200);
		const { id: invitationId } = (await sent.json()) as { id: string };
		const admin = await signUp(adminEmail);
		const accepted = await post("/organization/accept-invitation", { invitationId }, admin.cookie);
		expect(accepted.status).toBe(200);

		const next = newAddress();
		expect((await invite(admin.cookie, organizationId, next)).status).toBe(200);
		await signUp(next);
		expect(await accountsWith(next)).toBe(1);
	});

	it("count the owner as running a workspace only as its owner or an admin", async () => {
		const { owner, admin, organizationId } = await someoneElsesWorkspace();
		await addMember(organizationId, owner.userId, "member");
		const pending = newAddress();
		expect((await invite(admin.cookie, organizationId, pending)).status).toBe(200);
		await closeSignUp();

		await refused(
			await invite(admin.cookie, organizationId, newAddress()),
			"WORKSPACE_CANNOT_INVITE",
		);
		await requestCode(pending);
		expect(await codesStoredFor(pending)).toBe(0);
		await expect(insertAccount(pending)).rejects.toThrow("sign-up is closed here");

		await id.db
			.prepare("UPDATE member SET role = 'admin' WHERE user_id = ?")
			.bind(owner.userId)
			.run();
		expect((await invite(admin.cookie, organizationId, newAddress())).status).toBe(200);
		await requestCode(pending);
		expect(await codesStoredFor(pending)).toBe(1);
		await insertAccount(pending);
		expect(await accountsWith(pending)).toBe(1);
	});

	it("stop being a way in if the owner stops running the workspace", async () => {
		const { owner, admin, organizationId } = await someoneElsesWorkspace();
		await addMember(organizationId, owner.userId, "admin");
		await closeSignUp();
		const pending = newAddress();
		expect((await invite(admin.cookie, organizationId, pending)).status).toBe(200);

		await id.db.prepare("DELETE FROM member WHERE user_id = ?").bind(owner.userId).run();

		await refused(
			await invite(admin.cookie, organizationId, newAddress()),
			"WORKSPACE_CANNOT_INVITE",
		);
		await requestCode(pending);
		expect(await codesStoredFor(pending)).toBe(0);
		await expect(insertAccount(pending)).rejects.toThrow("sign-up is closed here");
	});

	it("look at the workspace in question, not another the owner runs", async () => {
		const { owner, admin, organizationId } = await someoneElsesWorkspace();
		expect((await makeWorkspace(owner.cookie, "the-owners")).status).toBe(200);
		const pending = newAddress();
		expect((await invite(admin.cookie, organizationId, pending)).status).toBe(200);
		await closeSignUp();

		await refused(
			await invite(admin.cookie, organizationId, newAddress()),
			"WORKSPACE_CANNOT_INVITE",
		);
		expect(await mayInvite(admin.cookie, "someone-elses")).toBe(false);
		await requestCode(pending);
		expect(await codesStoredFor(pending)).toBe(0);
		await expect(insertAccount(pending)).rejects.toThrow("sign-up is closed here");
	});

	async function memberIdOf(organizationId: string, userId: string) {
		const row = await id.db
			.prepare("SELECT id FROM member WHERE organization_id = ? AND user_id = ?")
			.bind(organizationId, userId)
			.first<{ id: string }>();
		expect(row?.id).toEqual(expect.any(String));
		return row?.id ?? "";
	}

	function changeRole(cookie: string, organizationId: string, memberId: string, role: string) {
		return post("/organization/update-member-role", { organizationId, memberId, role }, cookie);
	}

	it.each(["admin", "owner"])(
		"stay closed when an admin tries to make the server's owner %s",
		async (role) => {
			const { owner, admin, organizationId } = await someoneElsesWorkspace();
			await addMember(organizationId, owner.userId, "member");
			const pending = newAddress();
			expect((await invite(admin.cookie, organizationId, pending)).status).toBe(200);
			await closeSignUp();

			await refused(
				await changeRole(
					admin.cookie,
					organizationId,
					await memberIdOf(organizationId, owner.userId),
					role,
				),
				"SERVER_OWNER_STAYS_A_MEMBER",
			);

			expect(await mayInvite(admin.cookie, "someone-elses")).toBe(false);
			await requestCode(pending);
			expect(await codesStoredFor(pending)).toBe(0);
			await expect(insertAccount(pending)).rejects.toThrow("sign-up is closed here");
		},
	);

	it("still change anyone else's role, and the server owner's where they run it or sign-up is open", async () => {
		const { owner, admin, organizationId } = await someoneElsesWorkspace();
		await addMember(organizationId, owner.userId, "member");
		const someone = await signUp(newAddress());
		await addMember(organizationId, someone.userId, "member");
		const ownersMember = await memberIdOf(organizationId, owner.userId);
		await closeSignUp();

		const others = await memberIdOf(organizationId, someone.userId);
		expect((await changeRole(admin.cookie, organizationId, others, "admin")).status).toBe(200);

		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		expect((await changeRole(admin.cookie, organizationId, ownersMember, "admin")).status).toBe(
			200,
		);

		await closeSignUp();
		expect((await changeRole(admin.cookie, organizationId, ownersMember, "owner")).status).toBe(
			200,
		);
	});

	it("stay a way in when something writes the address in another case", async () => {
		const owner = await signUp(newAddress());
		const made = await makeWorkspace(owner.cookie, "the-owners");
		const { id: organizationId } = (await made.json()) as { id: string };
		const email = newAddress();
		expect((await invite(owner.cookie, organizationId, email)).status).toBe(200);

		await insertAccount(email.toUpperCase());
		expect(await accountsWith(email.toUpperCase())).toBe(1);
	});

	it("do not tell someone who may not send one that they may", async () => {
		const owner = await signUp(newAddress());
		const made = await makeWorkspace(owner.cookie, "the-owners");
		const { id: organizationId } = (await made.json()) as { id: string };
		const email = newAddress();
		const sent = await invite(owner.cookie, organizationId, email);
		const { id: invitationId } = (await sent.json()) as { id: string };
		const member = await signUp(email);
		await post("/organization/accept-invitation", { invitationId }, member.cookie);
		expect(await mayInvite(member.cookie, "the-owners")).toBe(false);
	});
});

describe("the owner's paths", () => {
	const OWNER_ONLY: [string, string, object | undefined][] = [
		["GET", "/deployment/get", undefined],
		["POST", "/deployment/sign-up", { signUp: "open" }],
		["POST", "/deployment/invitations/create", { email: "someone@example.com" }],
		["POST", "/deployment/invitations/cancel", { id: "any" }],
		["POST", "/deployment/password-link", { email: "someone@example.com", password: "any" }],
	];

	function call(method: string, path: string, body: object | undefined, cookie?: string) {
		if (method === "POST" && body) return post(path, body, cookie);
		return id.fetch(`${origin}/api/auth${path}`, {
			headers: { "cf-connecting-ip": newClient(), ...(cookie && { cookie }) },
		});
	}

	/** The owner and someone they let in, each signed in. */
	async function ownerAndMember() {
		const owner = await signUp(newAddress());
		const invited = newAddress();
		await ownerInvites(invited);
		return { owner, member: await signUp(invited) };
	}

	async function invite(cookie: string, email = newAddress()) {
		const response = await post("/deployment/invitations/create", { email }, cookie);
		expect(response.status).toBe(200);
		return { email, made: (await response.json()) as { id: string; link?: string } };
	}

	async function linkTo(email: string) {
		const link = /https:\S+\/join#\S+/.exec((await emailTo(email, "An invitation to")).text)?.[0];
		if (!link) throw new Error("No link in the invitation");
		return { link, token: new URL(link).hash.slice(1) };
	}

	it.each(OWNER_ONLY)("%s %s is not there for anyone else", async (method, path, body) => {
		const { member } = await ownerAndMember();
		expect((await call(method, path, body, member.cookie)).status).toBe(404);
		expect((await call(method, path, body)).status).toBe(401);
	});

	it("makes someone who deleted their account come back by a new invitation", async () => {
		await signUp(newAddress());
		const email = newAddress();
		await ownerInvites(email);
		const first = await signUp(email);
		expect((await post("/account/delete", {}, first.cookie)).status).toBe(200);
		expect(await accountsWith(email)).toBe(0);

		const stored = await codesStoredFor(email);
		expect((await requestCode(email)).status).toBe(200);
		expect(await codesStoredFor(email)).toBe(stored);

		await ownerInvites(email);
		expect((await requestCode(email)).status).toBe(200);
		const codes = await vi.waitFor(
			async () => {
				const sent = await emailsTo(email, CODE_EMAIL);
				if (sent.length < 2) throw new Error("No second code yet");
				return sent;
			},
			{ timeout: 5_000 },
		);
		const otp = /\b\d{6}\b/.exec(codes.at(-1)?.text ?? "")?.[0] ?? "";
		expect((await enterCode(email, otp)).status).toBe(200);
		expect(await accountsWith(email)).toBe(1);
	});

	it("does not let anyone else withdraw an invitation that is there", async () => {
		const { owner, member } = await ownerAndMember();
		const { email, made } = await invite(owner.cookie);
		const { token } = await linkTo(email);

		expect(
			(await post("/deployment/invitations/cancel", { id: made.id }, member.cookie)).status,
		).toBe(404);
		const read = await post("/deployment/invitations/read", { token });
		expect(await read.json()).toEqual({ email });
	});

	it("limits how often anyone can ask", async () => {
		const client = newClient();
		const answers: number[] = [];
		for (let asked = 0; asked < 62; asked++) {
			const response = await id.fetch(`${origin}/api/auth/deployment/get`, {
				headers: { "cf-connecting-ip": client },
			});
			answers.push(response.status);
		}
		expect(answers.slice(0, 60)).toEqual(Array(60).fill(401));
		expect(answers).toContain(429);
	});

	it("keeps what it answers out of caches", async () => {
		const { cookie } = await signUp(newAddress());
		const changed = await post("/deployment/sign-up", { signUp: "closed" }, cookie);
		const made = await post("/deployment/invitations/create", { email: newAddress() }, cookie);
		const { id: invitationId } = (await made.clone().json()) as { id: string };
		const withdrawn = await post("/deployment/invitations/cancel", { id: invitationId }, cookie);
		const { email } = await invite(cookie);
		const { token } = await linkTo(email);
		const used = await post("/deployment/invitations/accept", {
			token,
			name: "Someone",
			newPassword: PASSWORD,
		});
		for (const response of [changed, made, withdrawn, used]) {
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toContain("no-store");
		}
	});

	it("lets the owner open sign-up and close it, and says so in their activity", async () => {
		const { userId, cookie } = await signUp(newAddress());
		const opened = await post("/deployment/sign-up", { signUp: "open" }, cookie);
		expect(opened.status).toBe(200);
		expect((await theDeployment())?.signUp).toBe("open");
		await signUp(newAddress());

		expect((await post("/deployment/sign-up", { signUp: "closed" }, cookie)).status).toBe(200);
		expect((await theDeployment())?.signUp).toBe("closed");
		const stranger = newAddress();
		await requestCode(stranger);
		expect(await codesStoredFor(stranger)).toBe(0);

		await id.auditEventRecorded(userId, { type: "deployment_sign_up_changed", detail: "open" });
		await id.auditEventRecorded(userId, { type: "deployment_sign_up_changed", detail: "closed" });
	});

	it.each([
		["a word it does not know", { signUp: "perhaps" }],
		["anything else beside it", { signUp: "open", ownerId: "someone" }],
	])("refuses %s", async (_what, body) => {
		const { cookie } = await signUp(newAddress());
		expect((await post("/deployment/sign-up", body, cookie)).status).toBe(400);
		expect(await theDeployment()).toMatchObject({ signUp: "closed" });
	});

	it("wants a recent sign-in to let anyone in, though not to shut the door", async () => {
		const { userId, cookie } = await signUp(newAddress());
		const { made } = await invite(cookie);
		await id.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * HOUR, userId)
			.run();

		await refused(
			await post("/deployment/sign-up", { signUp: "open" }, cookie),
			"SESSION_NOT_FRESH",
		);
		expect((await theDeployment())?.signUp).toBe("closed");
		await refused(
			await post("/deployment/invitations/create", { email: newAddress() }, cookie),
			"SESSION_NOT_FRESH",
		);

		expect((await post("/deployment/sign-up", { signUp: "closed" }, cookie)).status).toBe(200);
		const withdrawn = await post("/deployment/invitations/cancel", { id: made.id }, cookie);
		expect(withdrawn.status).toBe(200);
	});

	it("emails the link to the address, and gives it to nobody else", async () => {
		const { userId, cookie } = await signUp(newAddress());
		const { email, made } = await invite(cookie);
		expect(made).not.toHaveProperty("link");

		const { link, token } = await linkTo(email);
		expect(link.startsWith(`${origin}/join#`)).toBe(true);
		const stored = await id.db
			.prepare("SELECT token_hash AS hash FROM deployment_invitation WHERE email = ?")
			.bind(email)
			.first<{ hash: string }>();
		expect(stored?.hash).toEqual(expect.any(String));
		expect(stored?.hash).not.toBe(token);
		expect(token.length).toBeGreaterThanOrEqual(43);

		await id.auditEventRecorded(userId, { type: "deployment_invitation_created" });
		const listed = await id.fetch(`${origin}/api/auth/deployment/get`, {
			headers: { "cf-connecting-ip": newClient(), cookie },
		});
		const settings = await listed.text();
		expect(settings).toContain(email);
		expect(settings).not.toContain(token);
		expect(settings).not.toContain(stored?.hash ?? "?");
		expect(JSON.parse(settings)).toMatchObject({ sendsEmail: true });
		expect(listed.headers.get("cache-control")).toContain("no-store");
	});

	it("takes the address however it is typed", async () => {
		const { cookie } = await signUp(newAddress());
		const email = newAddress();
		await invite(cookie, email.toUpperCase());
		const row = await id.db
			.prepare("SELECT COUNT(*) AS rows FROM deployment_invitation WHERE email = ?")
			.bind(email)
			.first<{ rows: number }>();
		expect(row?.rows).toBe(1);
	});

	it("refuses an address longer than any can be", async () => {
		const { cookie } = await signUp(newAddress());
		await refused(
			await post(
				"/deployment/invitations/create",
				{ email: `${"a".repeat(243)}@example.com` },
				cookie,
			),
			"INVALID_REQUEST",
			400,
		);
	});

	it("refuses to invite an address that has an account", async () => {
		const owner = newAddress();
		const { cookie } = await signUp(owner);
		await refused(
			await post("/deployment/invitations/create", { email: owner }, cookie),
			"ALREADY_HAS_ACCOUNT",
			400,
		);
	});

	it("does not let an invitation be a way to mail someone over and over", async () => {
		const { cookie } = await signUp(newAddress());
		const email = newAddress();
		const answers: number[] = [];
		for (let asked = 0; asked < 5; asked++) {
			answers.push((await post("/deployment/invitations/create", { email }, cookie)).status);
		}
		expect(answers.slice(0, 3)).toEqual([200, 200, 200]);
		expect(answers.slice(3)).toEqual([429, 429]);
	});

	it("makes the old link stop working when asked again", async () => {
		const { cookie } = await signUp(newAddress());
		const email = newAddress();
		await invite(cookie, email);
		const { token: old } = await linkTo(email);
		await invite(cookie, email);
		await vi.waitFor(async () => {
			expect(await emailsTo(email, "An invitation to")).toHaveLength(2);
		});
		const [, second] = await emailsTo(email, "An invitation to");
		const token = new URL(/https:\S+\/join#\S+/.exec(second?.text ?? "")?.[0] ?? "").hash.slice(1);

		await refused(
			await post("/deployment/invitations/read", { token: old }),
			"INVITATION_NOT_FOUND",
			404,
		);
		const read = await post("/deployment/invitations/read", { token });
		expect(await read.json()).toEqual({ email });
	});

	it("makes a withdrawn link stop working", async () => {
		const { userId, cookie } = await signUp(newAddress());
		const { email, made } = await invite(cookie);
		const { token } = await linkTo(email);
		const other = await invite(cookie);
		const { token: otherToken } = await linkTo(other.email);

		expect((await post("/deployment/invitations/cancel", { id: made.id }, cookie)).status).toBe(
			200,
		);
		await refused(
			await post("/deployment/invitations/read", { token }),
			"INVITATION_NOT_FOUND",
			404,
		);
		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "Too Late",
				newPassword: PASSWORD,
			}),
			"INVITATION_NOT_FOUND",
			404,
		);
		expect(await accountsWith(email)).toBe(0);
		await refused(
			await post("/deployment/invitations/cancel", { id: made.id }, cookie),
			"INVITATION_NOT_FOUND",
			404,
		);
		await id.auditEventRecorded(userId, { type: "deployment_invitation_canceled" });

		const stillGood = await post("/deployment/invitations/read", { token: otherToken });
		expect(await stillGood.json()).toEqual({ email: other.email });
	});

	it("makes a link that has run out stop working", async () => {
		const { cookie } = await signUp(newAddress());
		const { email } = await invite(cookie);
		const { token } = await linkTo(email);
		await id.db
			.prepare("UPDATE deployment_invitation SET expires_at = ? WHERE email = ?")
			.bind(Date.now() - 1000, email)
			.run();

		await refused(
			await post("/deployment/invitations/read", { token }),
			"INVITATION_NOT_FOUND",
			404,
		);
		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "Too Late",
				newPassword: PASSWORD,
			}),
			"INVITATION_NOT_FOUND",
			404,
		);
		expect(await accountsWith(email)).toBe(0);
	});

	it("gives a link a week, and lists only those still good", async () => {
		const { cookie } = await signUp(newAddress());
		const before = Date.now();
		const { email: late } = await invite(cookie);
		const { email: fine } = await invite(cookie);
		const after = Date.now();
		const listed = async () => {
			const response = await id.fetch(`${origin}/api/auth/deployment/get`, {
				headers: { "cf-connecting-ip": newClient(), cookie },
			});
			const { invitations } = (await response.json()) as {
				invitations: { email: string; expiresAt: string }[];
			};
			return invitations;
		};
		const link = (await listed()).find(({ email }) => email === fine);
		const expiresAt = new Date(link?.expiresAt ?? 0).getTime();
		expect(expiresAt).toBeGreaterThan(before + 7 * DAY - HOUR);
		expect(expiresAt).toBeLessThan(after + 7 * DAY + HOUR);

		await id.db
			.prepare("UPDATE deployment_invitation SET expires_at = ? WHERE email = ?")
			.bind(Date.now() - 1000, late)
			.run();
		expect((await listed()).map(({ email }) => email)).toEqual([fine]);
	});

	it("lets the person in, once, with the password they chose and a proven address", async () => {
		const { cookie } = await signUp(newAddress());
		const { email } = await invite(cookie);
		const { token } = await linkTo(email);

		const read = await post("/deployment/invitations/read", { token });
		expect(await read.json()).toEqual({ email });
		expect(read.headers.get("cache-control")).toContain("no-store");

		const accepted = await post("/deployment/invitations/accept", {
			token,
			name: "  Invited Person  ",
			newPassword: PASSWORD,
		});
		expect(accepted.status).toBe(200);
		const session = await id.fetch(`${origin}/api/auth/get-session`, {
			headers: { "cf-connecting-ip": newClient(), cookie: cookieOf(accepted) },
		});
		expect(await session.json()).toMatchObject({
			user: { email, name: "Invited Person", emailVerified: true },
		});
		const made = await id.db
			.prepare("SELECT id FROM user WHERE email = ?")
			.bind(email)
			.first<{ id: string }>();
		await id.auditEventRecorded(made?.id ?? "?", { type: "account_created", detail: "invitation" });
		await id.auditEventRecorded(made?.id ?? "?", { type: "sign_in", detail: "invitation" });

		const signedIn = await post("/sign-in/email", { email, password: PASSWORD });
		expect(signedIn.status).toBe(200);

		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "Again",
				newPassword: PASSWORD,
			}),
			"INVITATION_NOT_FOUND",
			404,
		);
	});

	it("does not spend the link on a password it refuses, or a name", async () => {
		const { cookie } = await signUp(newAddress());
		const { email } = await invite(cookie);
		const { token } = await linkTo(email);

		await refused(
			await post("/deployment/invitations/accept", { token, name: "Short", newPassword: "short" }),
			"INVALID_PASSWORD_LENGTH",
			400,
		);
		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "Long",
				newPassword: "a".repeat(129),
			}),
			"INVALID_PASSWORD_LENGTH",
			400,
		);
		await refused(
			await post("/deployment/invitations/accept", { token, name: "  ", newPassword: PASSWORD }),
			"INVALID_REQUEST",
			400,
		);
		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "a".repeat(101),
				newPassword: PASSWORD,
			}),
			"INVALID_REQUEST",
			400,
		);
		expect(await accountsWith(email)).toBe(0);
		expect(
			(
				await post("/deployment/invitations/accept", {
					token,
					name: "Right",
					newPassword: PASSWORD,
				})
			).status,
		).toBe(200);
	});

	it("does not let a link take over an account that has appeared since", async () => {
		const { cookie } = await signUp(newAddress());
		const { email } = await invite(cookie);
		const { token } = await linkTo(email);
		const made = await signUp(email);

		await refused(
			await post("/deployment/invitations/accept", {
				token,
				name: "Thief",
				newPassword: PASSWORD,
			}),
			"INVITATION_NOT_FOUND",
			404,
		);
		// Nor if something puts an invitation back, for an address that has one.
		const owner = (await theDeployment())?.ownerId;
		await id.db
			.prepare(
				`INSERT INTO deployment_invitation (id, email, token_hash, invited_by, expires_at, created_at)
					VALUES ('back', ?, 'back-hash', ?, ?, 0)`,
			)
			.bind(email, owner, Date.now() + HOUR)
			.run();
		await id.db
			.prepare("UPDATE deployment_invitation SET token_hash = ? WHERE id = 'back'")
			.bind(createHash("sha256").update("put-back").digest("base64url"))
			.run();
		await refused(
			await post("/deployment/invitations/accept", {
				token: "put-back",
				name: "Thief",
				newPassword: PASSWORD,
			}),
			"INVITATION_NOT_FOUND",
			404,
		);
		const session = await id.fetch(`${origin}/api/auth/get-session`, {
			headers: { "cf-connecting-ip": newClient(), cookie: made.cookie },
		});
		expect(await session.json()).toMatchObject({ user: { name: "A Person" } });
	});

	it("does not answer a wrong token, however it is shaped", async () => {
		for (const token of ["wrong", "", "a".repeat(201)]) {
			const response = await post("/deployment/invitations/read", { token });
			expect([400, 404]).toContain(response.status);
			expect(await response.text()).not.toContain("@");
		}
		await refused(
			await post("/deployment/invitations/read", { token: "a".repeat(201) }),
			"INVALID_REQUEST",
			400,
		);
	});

	it.each<[string, object]>([
		["/deployment/invitations/read", { token: "guess" }],
		["/deployment/invitations/accept", { token: "guess", name: "Someone", newPassword: PASSWORD }],
		["/deployment/claim", { email: "someone@example.com", name: "Someone", newPassword: PASSWORD }],
	])("limits guesses at %s", async (path, body) => {
		const client = newClient();
		const answers: number[] = [];
		for (let asked = 0; asked < 12; asked++) {
			const response = await id.fetch(`${origin}/api/auth${path}`, {
				method: "POST",
				headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			answers.push(response.status);
		}
		expect(answers.slice(0, 10)).toEqual(Array(10).fill(404));
		expect(answers).toContain(429);
	});

	it("clears away invitations that have run out", async () => {
		await signUp(newAddress());
		const late = newAddress();
		const fine = newAddress();
		await ownerInvites(late, Date.now() - 1000);
		await ownerInvites(fine);
		await id.runCron();
		const { results } = await id.db
			.prepare("SELECT email FROM deployment_invitation")
			.all<{ email: string }>();
		expect(results.map(({ email }: { email: string }) => email)).toEqual([fine]);
	});

	it("offers the page to its owner, and to nobody else", async () => {
		const { owner, member } = await ownerAndMember();
		const page = (path: string, cookie?: string) =>
			id.fetch(`${origin}${path}`, {
				headers: { "cf-connecting-ip": newClient(), ...(cookie && { cookie }) },
			});

		expect((await page("/server", owner.cookie)).status).toBe(200);
		expect((await page("/server", member.cookie)).status).toBe(404);
		const away = await page("/server");
		expect(away.status).toBe(307);
		expect(away.headers.get("location")).toContain("/login");

		const OPEN_SETTINGS = "Open settings";
		expect(await (await page("/account", owner.cookie)).text()).toContain(OPEN_SETTINGS);
		expect(await (await page("/account", member.cookie)).text()).not.toContain(OPEN_SETTINGS);
	});
});

describe("a server that sends no email", () => {
	const bareOrigin = "https://bare.test";
	let bare: Awaited<ReturnType<typeof startId>>;

	beforeAll(async () => {
		bare = await startId(bareOrigin, {
			email: false,
			newDeployment: true,
			breachedPasswords: true,
		});
	});

	afterAll(async () => {
		await bare?.dispose();
	});

	beforeEach(async () => {
		await startOver(bare.db);
	});

	function barePost(path: string, body: object, cookie?: string) {
		return bare.fetch(`${bareOrigin}/api/auth${path}`, {
			method: "POST",
			headers: {
				origin: bareOrigin,
				"cf-connecting-ip": newClient(),
				"content-type": "application/json",
				...(cookie && { cookie }),
			},
			body: JSON.stringify(body),
		});
	}

	function claim(email = newAddress()) {
		return barePost("/deployment/claim", { email, name: "The Owner", newPassword: PASSWORD });
	}

	it("can be claimed by the first to come, who owns it, and then by nobody", async () => {
		const page = await bare.fetch(`${bareOrigin}/signup`);
		expect(await page.text()).toContain("Claim this server");

		const email = newAddress();
		const claimed = await claim(email.toUpperCase());
		expect(claimed.status).toBe(200);
		expect(claimed.headers.get("cache-control")).toContain("no-store");
		expect(cookieOf(claimed)).toContain("session_token");
		const owner = await bare.db
			.prepare("SELECT id, email_verified AS verified FROM user WHERE email = ?")
			.bind(email)
			.first<{ id: string; verified: number }>();
		expect(owner?.verified).toBe(1);
		await bare.auditEventRecorded(owner?.id ?? "?", { type: "sign_in", detail: "claim" });
		const row = await bare.db
			.prepare("SELECT owner_id AS ownerId, sign_up AS signUp FROM deployment")
			.first();
		expect(row).toEqual({ ownerId: owner?.id, signUp: "closed" });

		const signedIn = await barePost("/sign-in/email", { email, password: PASSWORD });
		expect(signedIn.status).toBe(200);

		const next = newAddress();
		expect((await claim(next)).status).toBe(404);
		const count = await bare.db
			.prepare("SELECT COUNT(*) AS accounts FROM user WHERE email = ?")
			.bind(next)
			.first<{ accounts: number }>();
		expect(count?.accounts).toBe(0);

		const after = await (await bare.fetch(`${bareOrigin}/signup`)).text();
		expect(after).not.toContain("Claim this server");
		expect(after).toContain("does not send email");
	});

	it("does not let an open one be claimed", async () => {
		await bare.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		expect((await claim()).status).toBe(404);
	});

	it("refuses a password known from a breach, at both ways in", async () => {
		await refused(
			await barePost("/deployment/claim", {
				email: newAddress(),
				name: "The Owner",
				newPassword: PWNED_PASSWORDS.breached,
			}),
			"PASSWORD_COMPROMISED",
			400,
		);
		const claimed = await claim();
		const asked = await barePost(
			"/deployment/invitations/create",
			{ email: newAddress() },
			cookieOf(claimed),
		);
		const { link } = (await asked.json()) as { link: string };
		const token = new URL(link).hash.slice(1);
		await refused(
			await barePost("/deployment/invitations/accept", {
				token,
				name: "Someone",
				newPassword: PWNED_PASSWORDS.breached,
			}),
			"PASSWORD_COMPROMISED",
			400,
		);
	});

	it("gives the owner a link to pass on, and sends nothing", async () => {
		const cookie = cookieOf(await claim());
		const email = newAddress();
		const asked = await barePost("/deployment/invitations/create", { email }, cookie);
		expect(asked.status).toBe(200);
		const { link } = (await asked.json()) as { link: string };
		expect(link.startsWith(`${bareOrigin}/join#`)).toBe(true);
		expect(await bare.emails()).toEqual([]);
		const settings = await bare.fetch(`${bareOrigin}/api/auth/deployment/get`, {
			headers: { "cf-connecting-ip": newClient(), cookie },
		});
		expect(await settings.json()).toMatchObject({ sendsEmail: false });

		const accepted = await barePost("/deployment/invitations/accept", {
			token: new URL(link).hash.slice(1),
			name: "Someone",
			newPassword: PASSWORD,
		});
		expect(accepted.status).toBe(200);
		expect(cookieOf(accepted)).toContain("session_token");
		const row = await bare.db
			.prepare("SELECT email_verified AS verified FROM user WHERE email = ?")
			.bind(email)
			.first<{ verified: number }>();
		expect(row?.verified).toBe(1);
	});

	it("keeps a workspace's invitation for someone to find, and sends nothing", async () => {
		const cookie = cookieOf(await claim());
		const made = await barePost("/organization/create", { name: "Solo", slug: "solo" }, cookie);
		const { id: organizationId } = (await made.json()) as { id: string };
		const email = newAddress();
		const invited = await barePost(
			"/organization/invite-member",
			{ organizationId, email, role: "member" },
			cookie,
		);
		expect(invited.status).toBe(200);
		expect(await bare.emails()).toEqual([]);

		const asked = await barePost("/deployment/invitations/create", { email }, cookie);
		const { link } = (await asked.json()) as { link: string };
		const accepted = await barePost("/deployment/invitations/accept", {
			token: new URL(link).hash.slice(1),
			name: "Someone",
			newPassword: PASSWORD,
		});
		const listed = await bare.fetch(`${bareOrigin}/api/auth/workspaces/list`, {
			headers: { "cf-connecting-ip": newClient(), cookie: cookieOf(accepted) },
		});
		const { invitations } = (await listed.json()) as { invitations: { workspace: string }[] };
		expect(invitations.map(({ workspace }) => workspace)).toEqual(["Solo"]);
	});

	describe("helping someone back in", () => {
		const NEW_PASSWORD = "another-long-password-for-tests";

		function idOf(email: string) {
			return bare.db
				.prepare("SELECT id FROM user WHERE email = ?")
				.bind(email)
				.first<{ id: string }>();
		}

		async function letIn(owner: string, name: string) {
			const email = newAddress();
			const asked = await barePost("/deployment/invitations/create", { email }, owner);
			const { link } = (await asked.json()) as { link: string };
			const accepted = await barePost("/deployment/invitations/accept", {
				token: new URL(link).hash.slice(1),
				name,
				newPassword: PASSWORD,
			});
			expect(accepted.status).toBe(200);
			return { email, cookie: cookieOf(accepted), id: (await idOf(email))?.id ?? "?" };
		}

		/** The owner and someone they let in, each signed in. */
		async function ownerAndPerson() {
			const ownerEmail = newAddress();
			const owner = cookieOf(await claim(ownerEmail));
			return {
				owner,
				ownerEmail,
				ownerId: (await idOf(ownerEmail))?.id ?? "?",
				person: await letIn(owner, "Someone"),
			};
		}

		function makeLink(owner: string, email: string, password: string | undefined = PASSWORD) {
			return barePost("/deployment/password-link", { email, password }, owner);
		}

		async function tokenFrom(response: Response) {
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toContain("no-store");
			const { link } = (await response.json()) as { link: string };
			expect(link.startsWith(`${bareOrigin}/reset-password#`)).toBe(true);
			return new URL(link).hash.slice(1);
		}

		function choose(token: string, newPassword = NEW_PASSWORD) {
			return barePost("/reset-password", { token, newPassword });
		}

		function signIn(email: string, password: string) {
			return barePost("/sign-in/email", { email, password });
		}

		async function activityOf(cookie: string) {
			const response = await bare.fetch(`${bareOrigin}/api/auth/account/activity`, {
				headers: { "cf-connecting-ip": newClient(), cookie },
			});
			const { events } = (await response.json()) as {
				events: {
					type: string;
					detail: string | null;
					byOther?: boolean;
					other?: string | null;
					ip: string | null;
				}[];
			};
			return events;
		}

		it("lets whoever opens the link choose a password, once, and ends the sessions there were", async () => {
			const { owner, ownerId, person } = await ownerAndPerson();
			const token = await tokenFrom(await makeLink(owner, person.email));
			expect(await bare.emails()).toEqual([]);

			// Until it is used, nothing has changed for them.
			expect((await signIn(person.email, PASSWORD)).status).toBe(200);
			const stillIn = await bare.fetch(`${bareOrigin}/api/auth/get-session`, {
				headers: { "cf-connecting-ip": newClient(), cookie: person.cookie },
			});
			expect(await stillIn.json()).toMatchObject({ user: { email: person.email } });

			expect((await choose(token)).status).toBe(200);
			const ended = await bare.fetch(`${bareOrigin}/api/auth/get-session`, {
				headers: { "cf-connecting-ip": newClient(), cookie: person.cookie },
			});
			expect(await ended.json()).toBeNull();
			expect((await signIn(person.email, PASSWORD)).status).toBe(401);
			const back = await signIn(person.email, NEW_PASSWORD);
			expect(back.status).toBe(200);
			await refused(await choose(token, "yet-another-long-password"), "INVALID_TOKEN", 400);

			await bare.auditEventRecorded(person.id, {
				type: "password_link_made",
				actor_id: ownerId,
			});
			await bare.auditEventRecorded(person.id, { type: "password_changed", detail: "link" });
			expect(await activityOf(cookieOf(back))).toContainEqual(
				expect.objectContaining({
					type: "password_link_made",
					byOther: true,
					other: "The Owner",
					// Where the owner was is not this person's to see.
					ip: null,
				}),
			);
			expect(await activityOf(owner)).toContainEqual(
				expect.objectContaining({ type: "password_link_made", byOther: false, other: "Someone" }),
			);
		});

		it("takes the address however it is typed", async () => {
			const { owner, person } = await ownerAndPerson();
			const token = await tokenFrom(await makeLink(owner, person.email.toUpperCase()));
			expect((await choose(token)).status).toBe(200);
		});

		it("wants the owner's password, and writes down a wrong one", async () => {
			const { owner, ownerId, person } = await ownerAndPerson();
			await refused(
				await barePost("/deployment/password-link", { email: person.email }, owner),
				"INVALID_PASSWORD",
				400,
			);
			await refused(
				await makeLink(owner, person.email, "not-the-password"),
				"INVALID_PASSWORD",
				400,
			);
			const links = await bare.db
				.prepare(
					"SELECT COUNT(*) AS links FROM verification WHERE identifier LIKE 'reset-password:%'",
				)
				.first<{ links: number }>();
			expect(links?.links).toBe(0);
			await bare.auditEventRecorded(ownerId, { type: "password_refused" });
			expect(await activityOf(person.cookie)).not.toContainEqual(
				expect.objectContaining({ type: "password_link_made" }),
			);
		});

		it("gives a stolen cookie only so many tries at the owner's password", async () => {
			const { owner, person } = await ownerAndPerson();
			// `PASSWORD_TRIES_PER_PERSON` in src/server/rate-limit/index.ts.
			for (let attempt = 0; attempt < 10; attempt++) {
				await refused(
					await makeLink(owner, person.email, `wrong-${attempt}`),
					"INVALID_PASSWORD",
					400,
				);
			}
			await refused(await makeLink(owner, person.email), "TOO_MANY_PASSWORD_TRIES", 429);
		});

		it("asks no password of an owner with none", async () => {
			const { owner, ownerId, person } = await ownerAndPerson();
			await bare.db
				.prepare("DELETE FROM account WHERE user_id = ? AND provider_id = 'credential'")
				.bind(ownerId)
				.run();
			const asked = await barePost("/deployment/password-link", { email: person.email }, owner);
			expect((await choose(await tokenFrom(asked))).status).toBe(200);
		});

		it("wants a recent sign-in, even with the right password", async () => {
			const { owner, ownerId, person } = await ownerAndPerson();
			await bare.db
				.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
				.bind(Date.now() - 2 * DAY, ownerId)
				.run();
			await refused(await makeLink(owner, person.email), "SESSION_NOT_FRESH");
		});

		it("is not there for anyone else, who can't tell it from a path that doesn't exist", async () => {
			const { person, ownerEmail } = await ownerAndPerson();
			expect((await makeLink(person.cookie, ownerEmail)).status).toBe(404);
			expect((await barePost("/deployment/password-link", { email: ownerEmail })).status).toBe(401);
		});

		it("is not there on a server that sends email, even for its owner", async () => {
			const owner = await signUp(newAddress());
			const invited = newAddress();
			await ownerInvites(invited);
			await signUp(invited);
			const asked = await post(
				"/deployment/password-link",
				{ email: invited, password: "any" },
				owner.cookie,
			);
			expect(asked.status).toBe(404);
			const links = await id.db
				.prepare(
					"SELECT COUNT(*) AS links FROM verification WHERE identifier LIKE 'reset-password:%'",
				)
				.first<{ links: number }>();
			expect(links?.links).toBe(0);
		});

		it("says so of an address with no account, and of the owner's own", async () => {
			const { owner, ownerEmail } = await ownerAndPerson();
			await refused(await makeLink(owner, newAddress()), "NO_SUCH_ACCOUNT", 400);
			await refused(await makeLink(owner, ownerEmail), "YOUR_OWN_ACCOUNT", 400);
		});

		it("leaves one link when several are asked for at once", async () => {
			const { owner, person } = await ownerAndPerson();
			const tokens = await Promise.all(
				[1, 2, 3, 4].map(async () => tokenFrom(await makeLink(owner, person.email))),
			);

			const statuses: number[] = [];
			for (const token of tokens) {
				statuses.push((await choose(token, `${NEW_PASSWORD}-${statuses.length}`)).status);
			}
			expect(statuses.filter((status) => status === 200)).toHaveLength(1);
		});

		it("takes an earlier link away when asked again, and only that person's", async () => {
			const { owner, person } = await ownerAndPerson();
			const other = await letIn(owner, "Someone Else");
			const others = await tokenFrom(await makeLink(owner, other.email));
			const astray = await tokenFrom(await makeLink(owner, person.email));
			const again = await tokenFrom(await makeLink(owner, person.email));

			await refused(await choose(astray), "INVALID_TOKEN", 400);
			expect((await choose(again)).status).toBe(200);
			expect((await choose(others)).status).toBe(200);
		});

		it("lasts a day, and stops working after", async () => {
			const { owner, person } = await ownerAndPerson();
			const token = await tokenFrom(await makeLink(owner, person.email));
			const row = await bare.db
				.prepare("SELECT expires_at AS expiresAt FROM verification WHERE identifier = ?")
				.bind(`reset-password:${token}`)
				.first<{ expiresAt: number }>();
			expect(row?.expiresAt).toBeGreaterThan(Date.now() + 23 * HOUR);
			expect(row?.expiresAt).toBeLessThanOrEqual(Date.now() + DAY);

			await bare.db
				.prepare("UPDATE verification SET expires_at = ? WHERE identifier = ?")
				.bind(Date.now() - 1000, `reset-password:${token}`)
				.run();
			await refused(await choose(token), "INVALID_TOKEN", 400);
			expect((await signIn(person.email, PASSWORD)).status).toBe(200);
		});

		it("does not spend the link on a password it refuses", async () => {
			const { owner, person } = await ownerAndPerson();
			const token = await tokenFrom(await makeLink(owner, person.email));
			await refused(await choose(token, PWNED_PASSWORDS.breached), "PASSWORD_COMPROMISED", 400);
			await refused(await choose(token, "short"), "PASSWORD_TOO_SHORT", 400);
			expect((await signIn(person.email, PASSWORD)).status).toBe(200);
			expect((await choose(token)).status).toBe(200);
		});

		it("leaves two-factor sign-in on, so the link alone gets nobody in", async () => {
			const { owner, person } = await ownerAndPerson();
			const asked = await barePost("/two-factor/enable", { password: PASSWORD }, person.cookie);
			const { totpURI } = (await asked.json()) as { totpURI: string };
			const key = new URL(totpURI).searchParams.get("secret") ?? "";
			const on = await barePost("/two-factor/verify-totp", { code: totp(key) }, person.cookie);
			expect(on.status).toBe(200);

			const token = await tokenFrom(await makeLink(owner, person.email));
			expect((await choose(token)).status).toBe(200);

			const signedIn = await signIn(person.email, NEW_PASSWORD);
			expect(signedIn.status).toBe(200);
			expect(await signedIn.json()).toMatchObject({ twoFactorRedirect: true });
			expect(cookieOf(signedIn)).not.toContain("session_token");
		});

		it("gives a password to someone with none", async () => {
			const { owner, person } = await ownerAndPerson();
			await bare.db
				.prepare("DELETE FROM account WHERE user_id = ? AND provider_id = 'credential'")
				.bind(person.id)
				.run();
			const token = await tokenFrom(await makeLink(owner, person.email));
			expect((await choose(token)).status).toBe(200);
			expect((await signIn(person.email, NEW_PASSWORD)).status).toBe(200);
		});

		it("lets an owner who is locked out back in with the statement in the guide", async () => {
			const { ownerEmail } = await ownerAndPerson();
			const guide = readFileSync(
				join(import.meta.dirname, "..", "..", "..", "docs", "self-hosting.md"),
				"utf8",
			);
			const statement = /"(INSERT INTO verification [^"]+)"/.exec(guide)?.[1];
			if (!statement) throw new Error("The guide has no such statement");
			// An address can hold a quote or a $( ), and this runs in a shell and in SQL. It needs none.
			expect(statement).not.toContain("@");
			const token = "a-token-as-openssl-would-make-it";
			await bare.db.prepare(statement.replaceAll("$TOKEN", token)).run();

			expect((await choose(token)).status).toBe(200);
			expect((await signIn(ownerEmail, NEW_PASSWORD)).status).toBe(200);
		});
	});
});

describe("a server with GitHub and no email", () => {
	const hubOrigin = "https://hub.test";
	let hub: Awaited<ReturnType<typeof startId>>;

	beforeAll(async () => {
		hub = await startId(hubOrigin, { email: false, github: true, newDeployment: true });
	});

	afterAll(async () => {
		await hub?.dispose();
	});

	beforeEach(async () => {
		await startOver(hub.db);
	});

	function hubPost(path: string, body: object, cookie?: string) {
		return hub.fetch(`${hubOrigin}/api/auth${path}`, {
			method: "POST",
			headers: {
				origin: hubOrigin,
				"cf-connecting-ip": newClient(),
				"content-type": "application/json",
				...(cookie && { cookie }),
			},
			body: JSON.stringify(body),
		});
	}

	it("is claimed by proving an address, and no other way", async () => {
		const page = await (await hub.fetch(`${hubOrigin}/signup`)).text();
		expect(page).toContain("Claim this server");
		expect(page).toContain("GitHub");
		expect(page).not.toContain("nothing checks the address");
		expect(page).not.toContain('type="password"');

		const email = newAddress();
		const claimed = await hubPost("/deployment/claim", {
			email,
			name: "Not Them",
			newPassword: PASSWORD,
		});
		expect(claimed.status).toBe(404);
		const row = await hub.db.prepare("SELECT COUNT(*) AS accounts FROM user").first();
		expect(row).toEqual({ accounts: 0 });

		expectIn(await signInAs(person(email), hub, hubOrigin));
		const owner = await hub.db.prepare("SELECT owner_id AS ownerId FROM deployment").first<{
			ownerId: string | null;
		}>();
		expect(owner?.ownerId).toEqual(expect.any(String));
	});

	it("does not hand someone an account whose password a stray link already chose", async () => {
		const first = await signInAs(person(newAddress()), hub, hubOrigin);
		const asked = await hubPost(
			"/deployment/invitations/create",
			{ email: newAddress() },
			cookieOf(first),
		);
		const { link, email } = (await asked.json()) as { link: string; email: string };
		const accepted = await hubPost("/deployment/invitations/accept", {
			token: new URL(link).hash.slice(1),
			name: "Whoever Held The Link",
			newPassword: PASSWORD,
		});
		expect(accepted.status).toBe(200);

		const response = await signInAs(person(email), hub, hubOrigin);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "", hubOrigin);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("account_not_linked");
		expect(cookieOf(response)).not.toContain("session_token");
		const linked = await hub.db
			.prepare(
				`SELECT COUNT(*) AS accounts FROM account
					JOIN user ON user.id = account.user_id
					WHERE user.email = ? AND account.provider_id = 'github'`,
			)
			.bind(email)
			.first();
		expect(linked).toEqual({ accounts: 0 });
	});

	it("lets someone invited make their account with GitHub, and come back", async () => {
		const first = await signInAs(person(newAddress()), hub, hubOrigin);
		const email = newAddress();
		await hubPost("/deployment/invitations/create", { email }, cookieOf(first));
		const invited = person(email);
		expectIn(await signInAs(invited, hub, hubOrigin));
		expectIn(await signInAs(invited, hub, hubOrigin));
	});
});

describe("claiming a server that sends email", () => {
	const mailOrigin = "https://mail.test";
	let mail: Awaited<ReturnType<typeof startId>>;

	beforeAll(async () => {
		mail = await startId(mailOrigin, { newDeployment: true });
	});

	afterAll(async () => {
		await mail?.dispose();
	});

	it("is not there: the first account proves its address with a code", async () => {
		const claimed = await mail.fetch(`${mailOrigin}/api/auth/deployment/claim`, {
			method: "POST",
			headers: {
				origin: mailOrigin,
				"cf-connecting-ip": newClient(),
				"content-type": "application/json",
			},
			body: JSON.stringify({ email: newAddress(), name: "The Owner", newPassword: PASSWORD }),
		});
		expect(claimed.status).toBe(404);
		const row = await mail.db.prepare("SELECT COUNT(*) AS accounts FROM user").first();
		expect(row).toEqual({ accounts: 0 });
	});
});

describe("the pages", () => {
	const BY_INVITATION = "This server takes new accounts by invitation";
	const FIRST_OWNS = "The first one owns it";

	async function signUpPage() {
		const response = await id.fetch(`${origin}/signup`);
		expect(response.status).toBe(200);
		return response.text();
	}

	it("tell the first person what they are about to become", async () => {
		const page = await signUpPage();
		expect(page).toContain(FIRST_OWNS);
		expect(page).not.toContain(BY_INVITATION);
	});

	it("say it is by invitation once it is", async () => {
		await signUp(newAddress());
		const page = await signUpPage();
		expect(page).toContain(BY_INVITATION);
		expect(page).not.toContain(FIRST_OWNS);
	});

	it("say neither on an open server", async () => {
		await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		const page = await signUpPage();
		expect(page).not.toContain(BY_INVITATION);
		expect(page).not.toContain(FIRST_OWNS);
	});

	it("explain a refusal at the sign-in page", async () => {
		const response = await id.fetch(`${origin}/login?error=SIGN_UP_CLOSED`);
		expect(await response.text()).toContain(BY_INVITATION);
	});

	it("explain why GitHub did not reach an account", async () => {
		const response = await id.fetch(`${origin}/login?error=account_not_linked`);
		expect(await response.text()).toContain("An account here already has that address");
	});
});

describe("the migration", () => {
	const migrations = join(import.meta.dirname, "..", "migrations");

	/** A database at the last version with no `deployment`, filled by `fill`, then brought up to date. */
	function upgraded(fill: (db: DatabaseSync) => void) {
		const db = new DatabaseSync(":memory:");
		for (const file of readdirSync(migrations)
			.filter((name) => name.endsWith(".sql"))
			.sort()) {
			if (file.endsWith("_deployment.sql")) fill(db);
			for (const statement of readFileSync(join(migrations, file), "utf8").split(
				"--> statement-breakpoint",
			)) {
				if (statement.trim()) db.exec(statement);
			}
		}
		return db;
	}

	function addAccount(db: DatabaseSync, userId: string, email: string, createdAt: number) {
		db.prepare(
			`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
				VALUES (?, 'Someone', ?, 1, ?, ?)`,
		).run(userId, email, createdAt, createdAt);
	}

	function row(db: DatabaseSync) {
		return db
			.prepare("SELECT owner_id AS ownerId, sign_up AS signUp FROM deployment")
			.all()
			.map((found) => ({ ...found }));
	}

	it("leaves a deployment with accounts open, and its oldest account the owner", () => {
		const db = upgraded((before) => {
			addAccount(before, "a-newer", "newer@example.com", 2000);
			addAccount(before, "z-oldest", "oldest@example.com", 1000);
		});
		expect(row(db)).toEqual([{ ownerId: "z-oldest", signUp: "open" }]);

		addAccount(db, "after", "after@example.com", 3000);
		expect(row(db)).toEqual([{ ownerId: "z-oldest", signUp: "open" }]);
		db.close();
	});

	it("starts a deployment with no accounts closed, for the first to own", () => {
		const db = upgraded(() => {});
		expect(row(db)).toEqual([{ ownerId: null, signUp: "closed" }]);

		addAccount(db, "first", "first@example.com", 1000);
		expect(row(db)).toEqual([{ ownerId: "first", signUp: "closed" }]);
		expect(() => addAccount(db, "second", "second@example.com", 2000)).toThrow(
			"sign-up is closed here",
		);
		db.close();
	});
});
