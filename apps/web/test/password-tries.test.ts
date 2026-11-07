import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startId } from "./id-worker";
import { totp } from "./totp";

// What someone holding a session can try at a password, through the public routes of the built
// Worker. A stolen cookie can be sent from many addresses, so every request here comes from one of
// its own, which keeps Better Auth's limit per address out of it.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";
const WRONG = "not-the-password";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

function newClient() {
	clients += 1;
	return `198.51.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
}

function api(path: string, init: { client?: string; cookie?: string; body?: object }) {
	const { client = newClient(), cookie, body } = init;
	return id.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": client,
			...(body && { "content-type": "application/json" }),
			...(cookie && { cookie }),
		},
		body: body && JSON.stringify(body),
	});
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0] ?? "")
		.filter((cookie) => !cookie.endsWith("="))
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
	const email = `guessed-at-${++people}@example.com`;
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
	const session = (await (await api("/get-session", { client, cookie })).json()) as {
		user: { id: string };
	};
	const accounts = await api("/list-accounts", { client, cookie });
	const rows = (await accounts.json()) as { id: string; providerId: string }[];
	const passwordRow = rows.find(({ providerId }) => providerId === "credential")?.id ?? "";
	expect(passwordRow).not.toBe("");
	return { email, cookie, userId: session.user.id, passwordRow };
}

type Person = Awaited<ReturnType<typeof newPerson>>;

type Asking = [path: string, body: (person: Person, password: string) => object];

const changing: Asking = [
	"/change-password",
	(_person, password) => ({ currentPassword: password, newPassword: "another-long-password" }),
];

const replacingCodes: Asking = [
	"/two-factor/generate-backup-codes",
	(_person, password) => ({ password }),
];

/** Every path where a session shows a password, and how each asks for it. */
const ASKING: Asking[] = [
	changing,
	replacingCodes,
	["/account/delete", (_person, password) => ({ password })],
	["/two-factor/enable", (_person, password) => ({ password })],
	["/two-factor/disable", (_person, password) => ({ password })],
	["/unlink-account", (person, password) => ({ accountId: person.passwordRow, password })],
];

function tryAt([path, body]: Asking, person: Person, password = WRONG): Promise<Response> {
	return api(path, { cookie: person.cookie, body: body(person, password) });
}

async function codeOf(response: Response) {
	return ((await response.json()) as { code?: string }).code;
}

async function refusedPasswords(person: Person) {
	const events = await id.auditEvents(person.userId);
	return events.filter(({ type }) => type === "password_refused");
}

describe("the allowance per person", () => {
	it("is ten tries, from however many addresses", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
		}
		const refused = await tryAt(changing, person);
		expect(refused.status).toBe(429);
		expect(await codeOf(refused)).toBe("TOO_MANY_PASSWORD_TRIES");
	});

	it("refuses the right password too once it is spent, which proves nothing to a guesser", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) await tryAt(changing, person);
		expect((await tryAt(changing, person, PASSWORD)).status).toBe(429);
		// It was not changed, whatever the answer says.
		const signedIn = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedIn.status).toBe(200);
	});

	it.each(ASKING)("is spent by %s, and refused there", async (...asking) => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(asking, person)).status).toBe(400);
		}
		expect((await tryAt(asking, person)).status).toBe(429);
		expect((await tryAt(changing, person)).status).toBe(429);
	});

	it("is the same one on every device of that person's", async () => {
		const person = await newPerson();
		const another = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(another.status).toBe(200);
		const device = { ...person, cookie: cookieOf(another) };
		for (let tries = 0; tries < 5; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
			expect((await tryAt(changing, device)).status).toBe(400);
		}
		expect((await tryAt(changing, person)).status).toBe(429);
		expect((await tryAt(changing, device)).status).toBe(429);
	});

	it("is not spent by a request with no password to check", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 11; tries++) {
			const nothing = await api("/account/delete", { cookie: person.cookie, body: {} });
			expect(nothing.status).toBe(400);
			const notAString = await api("/unlink-account", {
				cookie: person.cookie,
				body: { accountId: person.passwordRow, password: 42 },
			});
			expect(notAString.status).toBe(400);
		}
		expect((await tryAt(changing, person)).status).toBe(400);
	});
});

// The cap must not become a way to lock someone out.
describe("who cannot spend someone's allowance", () => {
	it("anyone with only their address, signing in or not", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 11; tries++) {
			const signingIn = await api("/sign-in/email", {
				body: { email: person.email, password: WRONG },
			});
			expect(signingIn.status).toBe(401);
			const noSession = await api("/change-password", {
				body: { currentPassword: WRONG, newPassword: "another-long-password" },
			});
			expect(noSession.status).toBe(401);
		}
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
		}
	});

	it("someone with a session of their own", async () => {
		const person = await newPerson();
		const stranger = await newPerson();
		for (let tries = 0; tries < 10; tries++) await tryAt(changing, stranger);
		expect((await tryAt(changing, stranger)).status).toBe(429);
		expect((await tryAt(changing, person)).status).toBe(400);
	});
});

describe("once it is spent", () => {
	it("still lets the person sign out other devices and sign in, which take the account back", async () => {
		const person = await newPerson();
		const signedIn = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedIn.status).toBe(200);
		const thief = { ...person, cookie: cookieOf(signedIn) };
		for (let tries = 0; tries < 11; tries++) await tryAt(changing, thief);
		expect((await tryAt(changing, thief)).status).toBe(429);

		const out = await api("/revoke-other-sessions", { cookie: person.cookie, body: {} });
		expect(out.status).toBe(200);
		const session = await api("/get-session", { cookie: thief.cookie });
		expect(await session.json()).toBeNull();
		const again = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(200);
	});
});

describe("what the person can see", () => {
	it("writes a row for a wrong password wherever a session gives one", async () => {
		const person = await newPerson();
		const client = newClient();
		// That one has nothing to replace until two-factor is on, as the next test has it.
		const checked = ASKING.filter((asking) => asking !== replacingCodes);
		for (const [path, body] of checked) {
			const refused = await api(path, {
				client,
				cookie: person.cookie,
				body: body(person, WRONG),
			});
			expect(refused.status, path).toBe(400);
			expect(await codeOf(refused), path).toBe("INVALID_PASSWORD");
		}
		await vi.waitFor(
			async () => expect(await refusedPasswords(person)).toHaveLength(checked.length),
			{ timeout: 5_000 },
		);
		const [row] = await refusedPasswords(person);
		expect(row).toMatchObject({ ip: client, user_id: person.userId });

		const activity = await api("/account/activity", { cookie: person.cookie });
		const { events } = (await activity.json()) as { events: { type: string; ip: string }[] };
		expect(events).toContainEqual(
			expect.objectContaining({ type: "password_refused", ip: client }),
		);
	});

	it("writes one for replacing recovery codes, once there are some", async () => {
		const person = await newPerson();
		const asked = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(asked.status).toBe(200);
		const { totpURI } = (await asked.json()) as { totpURI: string };
		const key = new URL(totpURI).searchParams.get("secret") ?? "";
		const confirmed = await api("/two-factor/verify-totp", {
			cookie: person.cookie,
			body: { code: totp(key) },
		});
		expect(confirmed.status).toBe(200);
		const enrolled = { ...person, cookie: cookieOf(confirmed) };

		const refused = await tryAt(replacingCodes, enrolled);
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_PASSWORD");
		await vi.waitFor(async () => expect(await refusedPasswords(person)).toHaveLength(1), {
			timeout: 5_000,
		});
	});

	it("writes none for a right password, or a request with no password", async () => {
		const person = await newPerson();
		const enabled = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(enabled.status).toBe(200);
		const nothing = await api("/account/delete", { cookie: person.cookie, body: {} });
		expect(nothing.status).toBe(400);
		const notAString = await api("/unlink-account", {
			cookie: person.cookie,
			body: { accountId: person.passwordRow, password: 42 },
		});
		expect(notAString.status).toBe(400);

		// Events are written after the response, so wait for one written later.
		expect((await tryAt(changing, person)).status).toBe(400);
		await vi.waitFor(async () => expect(await refusedPasswords(person)).toHaveLength(1), {
			timeout: 5_000,
		});
	});

	it("writes none once the allowance has gone, so guessing cannot fill the log", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 13; tries++) await tryAt(changing, person);
		await vi.waitFor(async () => expect(await refusedPasswords(person)).toHaveLength(10), {
			timeout: 5_000,
		});

		// Events are written after the response, so wait for one written later.
		const out = await api("/revoke-other-sessions", { cookie: person.cookie, body: {} });
		expect(out.status).toBe(200);
		await id.auditEventRecorded(person.userId, { type: "sessions_revoked" });
		expect(await refusedPasswords(person)).toHaveLength(10);
	});
});
