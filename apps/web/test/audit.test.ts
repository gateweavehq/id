import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appAddedStatement } from "../src/server/auth/app-row";
import { type AuditEventRow, startId } from "./id-worker";

// The audit log, through the public routes of the built Worker. Events are written after the
// response, so tests wait for them. A test that nothing was written waits for something written
// later instead, from the same person.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";
const CHROME_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each device comes from an address of its own, so rate limits stay out of the way. */
function newClient() {
	return `203.0.113.${++clients}`;
}

function api(
	worker: typeof id,
	path: string,
	init: { client: string; cookie?: string; body?: object; userAgent?: string },
) {
	return worker.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
			...(init.userAgent && { "user-agent": init.userAgent }),
		},
		body: init.body && JSON.stringify(init.body),
	});
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function codeSentTo(worker: typeof id, email: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await worker.emails()).find((message) => message.to === email);
		const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (code) return code;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No code reached ${email}`);
}

let people = 0;

/** A new person with a password, signed in on one device. */
async function newPerson(worker = id) {
	const email = `audited-${++people}@example.com`;
	const client = newClient();
	await api(worker, "/email-otp/send-verification-otp", {
		client,
		body: { email, type: "sign-in" },
	});
	const otp = await codeSentTo(worker, email);
	const entered = await api(worker, "/sign-in/email-otp", {
		client,
		body: { email, otp, name: "Ada" },
	});
	expect(entered.status).toBe(200);
	const cookie = cookieOf(entered);
	const set = await api(worker, "/account/first-password", {
		client,
		cookie,
		body: { newPassword: PASSWORD },
	});
	expect(set.status).toBe(200);
	const user = (await (await api(worker, "/get-session", { client, cookie })).json()) as {
		user: { id: string };
	};
	return { email, client, cookie, userId: user.user.id };
}

function signIn(email: string, password = PASSWORD, client = newClient(), userAgent?: string) {
	return api(id, "/sign-in/email", { client, body: { email, password }, userAgent });
}

describe("signing in", () => {
	it("records who, how, from where and on what", async () => {
		const person = await newPerson();
		const client = newClient();
		const response = await signIn(person.email, PASSWORD, client, CHROME_ON_WINDOWS);
		expect(response.status).toBe(200);

		await id.auditEventRecorded(person.userId, {
			type: "sign_in",
			detail: "password",
			ip: client,
			device: "Chrome on Windows",
		});
	});

	it("records no failure for one that worked", async () => {
		const person = await newPerson();
		const signedIn = await signIn(person.email);
		expect(signedIn.status).toBe(200);
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "password" });
		// Something later, from the same person.
		await api(id, "/revoke-other-sessions", {
			client: person.client,
			cookie: person.cookie,
			body: {},
		});
		await id.auditEventRecorded(person.userId, { type: "sessions_revoked" });

		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "sign_in_failed")).toEqual([]);
	});

	it("records an account made with a code, and signing in with it", async () => {
		const person = await newPerson();
		await id.auditEventRecorded(person.userId, {
			type: "account_created",
			detail: "code",
			ip: person.client,
		});
		await id.auditEventRecorded(person.userId, {
			type: "sign_in",
			detail: "code",
			ip: person.client,
		});
	});
});

describe("a failed sign-in", () => {
	it("is recorded against the account it was for", async () => {
		const person = await newPerson();
		const client = newClient();
		const response = await signIn(
			person.email,
			"not-the-password-at-all",
			client,
			CHROME_ON_WINDOWS,
		);
		expect(response.status).toBe(401);

		await id.auditEventRecorded(person.userId, {
			type: "sign_in_failed",
			detail: "password",
			ip: client,
			// What it is, and not the whole header, which can tell one person's browser from another's.
			device: "Chrome on Windows",
		});
	});

	it("finds the account whatever the case of the address", async () => {
		const person = await newPerson();
		await signIn(person.email.toUpperCase(), "not-the-password-at-all");
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed" });
	});

	it("leaves nothing for an address with no account, and never the address", async () => {
		const person = await newPerson();
		await signIn("no-such-person@example.com", "not-the-password-at-all");
		// Written after the one above, by the same path.
		await signIn(person.email, "not-the-password-at-all");
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed" });

		const { results } = await id.db.prepare("SELECT * FROM audit_event").all<AuditEventRow>();
		expect(results.length).toBeGreaterThan(0);
		expect(JSON.stringify(results)).not.toContain("no-such-person");
		// Nor anyone's address or password, in any row.
		expect(JSON.stringify(results)).not.toContain("@example.com");
		expect(JSON.stringify(results)).not.toContain("not-the-password");
		expect(
			results.filter((row: AuditEventRow) => row.type === "sign_in_failed" && !row.user_id),
		).toEqual([]);
	});
});

describe("changing an account", () => {
	it("records a first password, which is not connecting a provider", async () => {
		const person = await newPerson();
		await id.auditEventRecorded(person.userId, {
			type: "password_changed",
			detail: "first",
			ip: person.client,
		});
		// Something later, from the same person.
		await signIn(person.email, "not-the-password-at-all");
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed" });

		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "provider_linked")).toEqual([]);
	});

	it("records a changed password, and the new session it makes is not someone signing in", async () => {
		const person = await newPerson();
		const signedIn = await signIn(person.email, PASSWORD, person.client);
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "password" });
		const before = await id.auditEvents(person.userId);

		const changed = await api(id, "/change-password", {
			client: person.client,
			cookie: cookieOf(signedIn),
			body: {
				currentPassword: PASSWORD,
				newPassword: "another-long-password-for-tests",
				revokeOtherSessions: true,
			},
		});
		expect(changed.status).toBe(200);

		await id.auditEventRecorded(person.userId, { type: "password_changed", detail: "changed" });
		const after = await id.auditEvents(person.userId);
		const signIns = (events: typeof after) => events.filter(({ type }) => type === "sign_in");
		expect(signIns(after).length).toBe(signIns(before).length);
	});

	it("records no change that was refused", async () => {
		const person = await newPerson();
		const refused = await api(id, "/change-password", {
			client: person.client,
			cookie: person.cookie,
			body: { currentPassword: "not-the-password-at-all", newPassword: "another-long-password" },
		});
		expect(refused.status).toBeGreaterThanOrEqual(400);
		// Something later, by the same path.
		await signIn(person.email, "not-the-password-at-all");
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed" });

		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ detail }) => detail === "changed")).toEqual([]);
	});

	it("records a password reset, which has no session to go by", async () => {
		const person = await newPerson();
		const client = newClient();
		const asked = await api(id, "/request-password-reset", {
			client,
			body: { email: person.email, redirectTo: "/reset-password" },
		});
		expect(asked.status).toBe(200);
		const token = await vi.waitFor(
			async () => {
				const mail = (await id.emails()).find(
					({ to, text }) => to === person.email && text.includes("reset-password"),
				);
				const found = /reset-password\/([^?\s]+)/.exec(mail?.text ?? "")?.[1];
				if (!found) throw new Error("No reset email yet");
				return found;
			},
			{ timeout: 5_000 },
		);
		const reset = await api(id, "/reset-password", {
			client,
			body: { token, newPassword: "another-long-password-for-tests" },
		});
		expect(reset.status).toBe(200);

		await id.auditEventRecorded(person.userId, {
			type: "password_changed",
			detail: "reset",
			ip: client,
		});
	});

	it("records ending sessions elsewhere", async () => {
		const person = await newPerson();
		await signIn(person.email);
		const ended = await api(id, "/revoke-other-sessions", {
			client: person.client,
			cookie: person.cookie,
			body: {},
		});
		expect(ended.status).toBe(200);
		await id.auditEventRecorded(person.userId, {
			type: "sessions_revoked",
			ip: person.client,
		});
	});

	it("records ending every session, this one's too", async () => {
		const person = await newPerson();
		const ended = await api(id, "/revoke-sessions", {
			client: person.client,
			cookie: person.cookie,
			body: {},
		});
		expect(ended.status).toBe(200);
		await id.auditEventRecorded(person.userId, {
			type: "sessions_revoked",
			detail: "everywhere",
			ip: person.client,
		});
	});
});

describe("someone's own activity", () => {
	interface Activity {
		events: { type: string; at: string; detail: string | null; ip: string | null }[];
	}

	async function activityOf(person: { client: string; cookie: string }) {
		const response = await api(id, "/account/activity", person);
		expect(response.status).toBe(200);
		return { response, ...((await response.json()) as Activity) };
	}

	it("shows them what happened to their account, newest first", async () => {
		const person = await newPerson();
		await id.auditEventRecorded(person.userId, { type: "password_changed" });

		const { events } = await activityOf(person);
		expect(events.map(({ type }) => type)).toEqual(
			expect.arrayContaining(["account_created", "sign_in", "password_changed"]),
		);
		const times = events.map(({ at }) => new Date(at).getTime());
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it("shows nobody anyone else's", async () => {
		const person = await newPerson();
		const other = await newPerson();
		const client = newClient();
		await signIn(other.email, "not-the-password-at-all", client);
		await id.auditEventRecorded(other.userId, { type: "sign_in_failed", ip: client });
		await id.auditEventRecorded(person.userId, { type: "password_changed" });

		const { events } = await activityOf(person);
		expect(events.length).toBeGreaterThan(0);
		expect(events.map(({ ip }) => ip)).not.toContain(client);
	});

	it("is for someone signed in, and stays out of caches", async () => {
		const stranger = await api(id, "/account/activity", { client: newClient() });
		expect(stranger.status).toBe(401);

		const person = await newPerson();
		const { response } = await activityOf(person);
		expect(response.headers.get("cache-control")).toContain("no-store");
	});

	it("shows only the most recent", async () => {
		const person = await newPerson();
		const old = Array.from({ length: 60 }, (_, index) =>
			id.db
				.prepare("INSERT INTO audit_event (id, at, type, user_id) VALUES (?, ?, 'sign_in', ?)")
				.bind(`many-${index}`, Date.now() - 86_400_000 - index, person.userId),
		);
		await id.db.batch(old);
		await id.auditEventRecorded(person.userId, { type: "password_changed" });

		const { events } = await activityOf(person);
		expect(events.length).toBe(50);
		expect(events.map(({ type }) => type)).toContain("password_changed");
	});
});

describe("adding an app", () => {
	it("is recorded by the statement the script runs, with no person named", async () => {
		await id.db.prepare(appAddedStatement("o'brien-app")).run();
		const row = await id.db
			.prepare("SELECT * FROM audit_event WHERE type = 'app_added' AND app = ?")
			.bind("o'brien-app")
			.first<AuditEventRow>();
		expect(row?.user_id).toBeNull();
		expect(Math.abs((row?.at ?? 0) - Date.now())).toBeLessThan(60_000);
	});
});

describe("a write that fails", () => {
	let broken: typeof id;

	beforeAll(async () => {
		broken = await startId(origin);
	});

	afterAll(async () => {
		await broken?.dispose();
	});

	it("stops nobody signing in, and shows in the logs without saying whose it was", async () => {
		const person = await newPerson(broken);
		await broken.db.prepare("DROP TABLE audit_event").run();

		const signedIn = await api(broken, "/sign-in/email", {
			client: newClient(),
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedIn.status).toBe(200);
		const failed = await api(broken, "/sign-in/email", {
			client: newClient(),
			body: { email: person.email, password: "not-the-password-at-all" },
		});
		expect(failed.status).toBe(401);

		await vi.waitFor(
			() => {
				const logged = broken.logs.filter(({ level }) => level === "error").map((l) => l.message);
				expect(logged.join("\n")).toContain("audit: could not record sign_in");
				expect(logged.join("\n")).toContain("audit: could not record sign_in_failed");
			},
			{ timeout: 5_000 },
		);
		const logged = broken.logs
			.filter(({ message }) => message.includes("audit:"))
			.map(({ message }) => message)
			.join("\n");
		expect(logged).not.toContain(person.email);
		expect(logged).not.toContain(person.userId);
	});
});
