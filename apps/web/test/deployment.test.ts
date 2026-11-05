import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type GitHubPerson, gitHubCode, type SentEmail, startId } from "./id-worker";

// Who owns a deployment and who may make an account on it, through the public routes of the built
// Worker. What this protects is in "Who owns a deployment" in docs/architecture.md.

const origin = "https://id.test";

const CODE_EMAIL = "is your Gateweave ID code";
const EXISTS_EMAIL = "You already have a Gateweave ID account";
const HOUR = 60 * 60 * 1000;

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { github: true, newDeployment: true });
});

afterAll(async () => {
	await id?.dispose();
});

/** Each test starts on a server nobody has used. */
beforeEach(async () => {
	await id.db.batch(
		[
			"DELETE FROM organization",
			"DELETE FROM user",
			"DELETE FROM deployment_invitation",
			"DELETE FROM verification",
			`INSERT OR REPLACE INTO deployment (id, owner_id, sign_up, updated_at)
				VALUES (1, NULL, 'closed', 0)`,
		].map((statement) => id.db.prepare(statement)),
	);
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

/** The owner vouching for an address. The owner has no page for this yet, and `invited_by` is theirs. */
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

	it("gives nobody the place of an owner whose account has gone, while others remain", async () => {
		const { userId } = await signUp(newAddress());
		await id.db.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
		await signUp(newAddress());
		await id.db.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
		expect((await theDeployment())?.ownerId).toBeNull();

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

describe("GitHub on a new deployment", () => {
	function person(email: string): GitHubPerson {
		const number = ++gitHubIds;
		return {
			id: number,
			login: `person-${number}`,
			name: "Grace Hopper",
			emails: [{ email, primary: true, verified: true }],
		};
	}

	async function signInAs(someone: GitHubPerson) {
		const client = newClient();
		const started = await id.fetch(`${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
			body: JSON.stringify({ provider: "github", callbackURL: "/account" }),
		});
		expect(started.status).toBe(200);
		const { url } = (await started.json()) as { url: string };
		const query = new URLSearchParams({
			code: gitHubCode(someone),
			state: new URL(url).searchParams.get("state") ?? "",
		});
		return id.fetch(`${origin}/api/auth/callback/github?${query}`, {
			headers: { "cf-connecting-ip": client, cookie: cookieOf(started) },
		});
	}

	function expectIn(response: Response) {
		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/account");
		expect(cookieOf(response)).toContain("session_token");
	}

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
