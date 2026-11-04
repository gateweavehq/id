import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { PWNED_PASSWORDS, startId } from "./id-worker";

// Passwords known from a breach, through the public routes of the built Worker, with a stand-in for
// Have I Been Pwned.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";
const ANOTHER_PASSWORD = "another-long-password";

type Id = Awaited<ReturnType<typeof startId>>;

let checking: Id;
let notChecking: Id;

beforeAll(async () => {
	checking = await startId(origin, { breachedPasswords: true });
	notChecking = await startId(origin);
});

afterAll(async () => {
	await checking?.dispose();
	await notChecking?.dispose();
});

let clients = 0;
let people = 0;

function newClient() {
	return `203.0.113.${++clients}`;
}

function post(id: Id, path: string, client: string, body: object, cookie?: string) {
	return id.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function emailTo(id: Id, email: string, subject: RegExp) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await id.emails()).find(
			(message) => message.to === email && subject.test(message.subject),
		);
		if (sent) return sent;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No such email reached ${email}`);
}

/** Someone who has just entered their code, and has no password yet. */
async function newPerson(id: Id) {
	const email = `person-${++people}@example.com`;
	const client = newClient();
	await post(id, "/email-otp/send-verification-otp", client, { email, type: "sign-in" });
	const mail = await emailTo(id, email, /code/i);
	const otp = /\b\d{6}\b/.exec(mail.text)?.[0];
	const entered = await post(id, "/sign-in/email-otp", client, { email, otp, name: "Ada" });
	expect(entered.status).toBe(200);
	return { email, client, cookie: cookieOf(entered) };
}

async function withPassword(id: Id) {
	const person = await newPerson(id);
	const set = await post(
		id,
		"/account/first-password",
		person.client,
		{ newPassword: PASSWORD },
		person.cookie,
	);
	expect(set.status).toBe(200);
	return person;
}

async function expectRefused(response: Response) {
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
}

function signIn(id: Id, email: string, password: string) {
	return post(id, "/sign-in/email", newClient(), { email, password });
}

describe("choosing a password known from a breach", () => {
	it("is refused for a first password", async () => {
		const { client, cookie } = await newPerson(checking);
		await expectRefused(
			await post(
				checking,
				"/account/first-password",
				client,
				{ newPassword: PWNED_PASSWORDS.breached },
				cookie,
			),
		);
	});

	it("is refused when changing a password, which stays as it was", async () => {
		const { email, client, cookie } = await withPassword(checking);
		await expectRefused(
			await post(
				checking,
				"/change-password",
				client,
				{ currentPassword: PASSWORD, newPassword: PWNED_PASSWORDS.breached },
				cookie,
			),
		);
		expect((await signIn(checking, email, PASSWORD)).status).toBe(200);
	});

	it("is refused when resetting a password, and the link still works for a better one", async () => {
		const { email } = await withPassword(checking);
		await post(checking, "/request-password-reset", newClient(), { email, redirectTo: "/" });
		const mail = await emailTo(checking, email, /reset/i);
		const token = /reset-password\/([^?\s]+)/.exec(mail.text)?.[1];
		expect(token).toBeTruthy();
		await expectRefused(
			await post(checking, "/reset-password", newClient(), {
				token,
				newPassword: PWNED_PASSWORDS.breached,
			}),
		);
		const reset = await post(checking, "/reset-password", newClient(), {
			token,
			newPassword: ANOTHER_PASSWORD,
		});
		expect(reset.status).toBe(200);
	});
});

describe("what leaves ID", () => {
	it("is five characters of the password's SHA-1, and never the password", async () => {
		const { client, cookie } = await newPerson(checking);
		const before = checking.outbound.length;
		await post(checking, "/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const sent = checking.outbound.slice(before);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
	});

	it("is nothing when signing in, which chooses no password", async () => {
		const { email } = await withPassword(checking);
		const before = checking.outbound.length;
		expect((await signIn(checking, email, PASSWORD)).status).toBe(200);
		expect(checking.outbound.slice(before)).toEqual([]);
	});
});

describe("when the service cannot answer", () => {
	it("lets the password through if the service is down", async () => {
		const { email, client, cookie } = await newPerson(checking);
		const set = await post(
			checking,
			"/account/first-password",
			client,
			{ newPassword: PWNED_PASSWORDS.serviceDown },
			cookie,
		);
		expect(set.status).toBe(200);
		expect((await signIn(checking, email, PWNED_PASSWORDS.serviceDown)).status).toBe(200);
	});

	it("does not wait for long", async () => {
		const { client, cookie } = await newPerson(checking);
		const started = Date.now();
		const set = await post(
			checking,
			"/account/first-password",
			client,
			{ newPassword: PWNED_PASSWORDS.noAnswer },
			cookie,
		);
		expect(set.status).toBe(200);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

describe("who has it on", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");

	it.each(["cloud", "staging"])("%s does", (env) => {
		expect(unstable_readConfig({ config, env }).vars.CHECK_BREACHED_PASSWORDS).toBe("1");
	});

	it("a self-hosted deployment does not, until it chooses to", () => {
		expect(unstable_readConfig({ config }).vars.CHECK_BREACHED_PASSWORDS).toBeUndefined();
	});
});

describe("a deployment that has not chosen it", () => {
	it("asks nobody, and takes the password", async () => {
		const { client, cookie } = await newPerson(notChecking);
		const before = notChecking.outbound.length;
		const set = await post(
			notChecking,
			"/account/first-password",
			client,
			{ newPassword: PWNED_PASSWORDS.breached },
			cookie,
		);
		expect(set.status).toBe(200);
		expect(notChecking.outbound.slice(before)).toEqual([]);
	});
});
