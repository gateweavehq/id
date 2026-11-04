import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId } from "./id-worker";

// The account page's promises, through the public routes of the built Worker.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";

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

function api(path: string, init: { client: string; cookie?: string; body?: object }) {
	return id.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
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

async function codeSentTo(email: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await id.emails()).find((message) => message.to === email);
		const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (code) return code;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No code reached ${email}`);
}

let people = 0;

/** A new person with a password, signed in on one device. */
async function newPerson() {
	const email = `person-${++people}@example.com`;
	const client = newClient();
	await api("/email-otp/send-verification-otp", { client, body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { client, body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const cookie = cookieOf(entered);
	const set = await api("/account/first-password", {
		client,
		cookie,
		body: { newPassword: PASSWORD },
	});
	expect(set.status).toBe(200);
	return { email, client, cookie };
}

async function signIn(email: string, password = PASSWORD) {
	const client = newClient();
	const response = await api("/sign-in/email", { client, body: { email, password } });
	return { response, client, cookie: cookieOf(response) };
}

async function isSignedIn(device: { client: string; cookie: string }) {
	const response = await api("/get-session", device);
	return Boolean(await response.json());
}

interface ListedSession {
	id: string;
	token: string;
	userId: string;
}

async function sessionsOf(device: { client: string; cookie: string }) {
	const response = await api("/list-sessions", device);
	expect(response.status).toBe(200);
	return (await response.json()) as ListedSession[];
}

describe("the page", () => {
	it("sends who is signed in to the page, but not their session's token", async () => {
		const person = await newPerson();
		const token = decodeURIComponent(person.cookie.split("=")[1] ?? "").split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const response = await id.fetch(`${origin}/account`, {
			headers: { cookie: person.cookie, "cf-connecting-ip": person.client },
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(person.email);
		expect(html).not.toContain(token);
	});

	it("sends anyone without a session to sign in", async () => {
		const response = await id.fetch(`${origin}/account`);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toContain("/login");
	});
});

describe("changing a password", () => {
	it("signs out every other device and keeps this one, and only the new one works", async () => {
		const person = await newPerson();
		const elsewhere = await signIn(person.email);
		expect(await isSignedIn(elsewhere)).toBe(true);

		const changed = await api("/change-password", {
			client: person.client,
			cookie: person.cookie,
			body: {
				currentPassword: PASSWORD,
				newPassword: "another-long-password",
				revokeOtherSessions: true,
			},
		});
		expect(changed.status).toBe(200);

		expect(await isSignedIn(elsewhere)).toBe(false);
		expect(await isSignedIn({ client: person.client, cookie: cookieOf(changed) })).toBe(true);
		expect((await signIn(person.email)).response.status).toBe(401);
		expect((await signIn(person.email, "another-long-password")).response.status).toBe(200);
	});

	it("needs the current password", async () => {
		const person = await newPerson();
		const refused = await api("/change-password", {
			client: person.client,
			cookie: person.cookie,
			body: { currentPassword: "not-the-password", newPassword: "another-long-password" },
		});
		expect(refused.status).toBe(400);
		expect((await signIn(person.email)).response.status).toBe(200);
	});
});

describe("sessions", () => {
	it("lists only the person's own", async () => {
		const person = await newPerson();
		const stranger = await newPerson();
		const elsewhere = await signIn(person.email);

		const sessions = await sessionsOf(person);
		expect(sessions).toHaveLength(2);
		expect(new Set(sessions.map((session) => session.userId)).size).toBe(1);
		const strangers = await sessionsOf(stranger);
		expect(strangers.map((session) => session.id)).not.toContain(sessions[0]?.id);
		expect(await isSignedIn(elsewhere)).toBe(true);
	});

	it("ends one device, leaving the others", async () => {
		const person = await newPerson();
		const second = await signIn(person.email);
		const third = await signIn(person.email);
		const [secondSession] = await sessionsOf(second).then((sessions) =>
			sessions.filter((session) => second.cookie.includes(session.token)),
		);
		expect(secondSession).toBeDefined();

		const revoked = await api("/revoke-session", {
			client: person.client,
			cookie: person.cookie,
			body: { token: secondSession?.token },
		});
		expect(revoked.status).toBe(200);

		expect(await isSignedIn(second)).toBe(false);
		expect(await isSignedIn(third)).toBe(true);
		expect(await isSignedIn(person)).toBe(true);
	});

	it("ends every other device at once", async () => {
		const person = await newPerson();
		const second = await signIn(person.email);
		const third = await signIn(person.email);

		const revoked = await api("/revoke-other-sessions", {
			client: person.client,
			cookie: person.cookie,
			body: {},
		});
		expect(revoked.status).toBe(200);

		expect(await isSignedIn(second)).toBe(false);
		expect(await isSignedIn(third)).toBe(false);
		expect(await isSignedIn(person)).toBe(true);
	});

	it("cannot end someone else's", async () => {
		const person = await newPerson();
		const stranger = await newPerson();
		const [target] = await sessionsOf(person);

		await api("/revoke-session", {
			client: stranger.client,
			cookie: stranger.cookie,
			body: { token: target?.token },
		});

		expect(await isSignedIn(person)).toBe(true);
	});
});

describe("the name", () => {
	it("changes, within the rules", async () => {
		const person = await newPerson();
		const renamed = await api("/update-user", {
			client: person.client,
			cookie: person.cookie,
			body: { name: "Ada King" },
		});
		expect(renamed.status).toBe(200);
		const session = (await (await api("/get-session", person)).json()) as {
			user: { name: string };
		};
		expect(session.user.name).toBe("Ada King");

		const blank = await api("/update-user", {
			client: person.client,
			cookie: person.cookie,
			body: { name: "   " },
		});
		expect(blank.status).toBe(400);
	});

	it("cannot be changed into a different email address on the way", async () => {
		const person = await newPerson();
		await api("/update-user", {
			client: person.client,
			cookie: person.cookie,
			body: { name: "Ada", email: "elsewhere@example.com", emailVerified: true },
		});
		const session = (await (await api("/get-session", person)).json()) as {
			user: { email: string };
		};
		expect(session.user.email).toBe(person.email);
	});
});
