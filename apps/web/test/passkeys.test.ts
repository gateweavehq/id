import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRow, insertStatement } from "../scripts/app-row";
import { type Ceremony, FakeAuthenticator } from "./fake-authenticator";
import { type GitHubPerson, gitHubCode, startId } from "./id-worker";

// What the server accepts and refuses from an authenticator, through the public routes of the built
// Worker. e2e/passkeys.spec.ts has the browser's side.

const origin = "https://id.test";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { github: true });
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

function newClient() {
	return `203.0.113.${++clients}`;
}

function api(
	path: string,
	init: { client: string; cookie?: string; body?: object },
	worker: { fetch: typeof id.fetch } = id,
) {
	return worker.fetch(`${origin}/api/auth${path}`, {
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
		.map((cookie) => cookie.split(";")[0] ?? "")
		.filter((cookie) => !cookie.endsWith("="))
		.join("; ");
}

function withCookie(cookie: string, response: Response) {
	const added = cookieOf(response);
	return added ? `${cookie}; ${added}` : cookie;
}

async function codeSentTo(email: string, worker: { emails: typeof id.emails } = id) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await worker.emails()).find((message) => message.to === email);
		const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (code) return code;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No code reached ${email}`);
}

interface Person {
	email: string;
	client: string;
	cookie: string;
	userId: string;
}

let people = 0;

/** Someone who has proved an address with a code, and has no other way to sign in yet. */
async function newPersonWithOnlyACode(worker: typeof id = id): Promise<Person> {
	const email = `person-${++people}@example.com`;
	const client = newClient();
	await api(
		"/email-otp/send-verification-otp",
		{ client, body: { email, type: "sign-in" } },
		worker,
	);
	const otp = await codeSentTo(email, worker);
	const entered = await api(
		"/sign-in/email-otp",
		{ client, body: { email, otp, name: "Ada" } },
		worker,
	);
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	return { email, client, cookie: cookieOf(entered), userId: user.id };
}

async function newPersonWithAPassword(): Promise<Person> {
	const person = await newPersonWithOnlyACode();
	const set = await api("/account/first-password", {
		...person,
		body: { newPassword: "a-long-password-for-tests" },
	});
	expect(set.status).toBe(200);
	return person;
}

interface RegistrationOptions {
	challenge: string;
	rp: { id: string; name: string };
	user: { name: string };
	attestation: string;
	excludeCredentials: { id: string }[];
	authenticatorSelection: { residentKey: string; userVerification: string };
}

async function askToRegister(person: Person) {
	const response = await api("/passkey/generate-register-options", person);
	expect(response.status).toBe(200);
	return {
		options: (await response.clone().json()) as RegistrationOptions,
		cookie: withCookie(person.cookie, response),
	};
}

/** Takes an authenticator through adding a passkey. */
async function tryToRegister(
	person: Person,
	authenticator = new FakeAuthenticator(origin),
	ceremony: Ceremony = {},
	body: object = {},
) {
	const { options, cookie } = await askToRegister(person);
	return api("/passkey/verify-registration", {
		client: person.client,
		cookie,
		body: { response: authenticator.register(options, ceremony), ...body },
	});
}

interface Passkey {
	id: string;
	name: string;
	userId: string;
	credentialID: string;
}

async function passkeysOf(person: Person) {
	const response = await api("/passkey/list-user-passkeys", person);
	expect(response.status).toBe(200);
	return (await response.json()) as Passkey[];
}

/** Someone with a passkey they can sign in with. */
async function withPasskey(person: Person) {
	const authenticator = new FakeAuthenticator(origin);
	const added = await tryToRegister(person, authenticator);
	expect(added.status).toBe(200);
	const { id: passkeyId } = (await added.json()) as { id: string };
	return { authenticator, passkeyId };
}

interface AuthenticationOptions {
	challenge: string;
	rpId: string;
	userVerification: string;
	allowCredentials?: unknown[];
}

async function askToSignIn(client: string, cookie?: string) {
	const response = await api("/passkey/generate-authenticate-options", {
		client,
		...(cookie && { cookie }),
	});
	expect(response.status).toBe(200);
	return {
		options: (await response.clone().json()) as AuthenticationOptions,
		cookie: cookieOf(response),
	};
}

/** Takes an authenticator through signing in, from a new device. */
async function tryToSignIn(authenticator: FakeAuthenticator, ceremony: Ceremony = {}) {
	const client = newClient();
	const { options, cookie } = await askToSignIn(client);
	const response = await api("/passkey/verify-authentication", {
		client,
		cookie,
		body: { response: authenticator.signIn(options, ceremony) },
	});
	return { response, client };
}

async function sessionOf(client: string, response: Response) {
	const reply = await api("/get-session", { client, cookie: cookieOf(response) });
	return (await reply.json()) as { user: { id: string } } | null;
}

/** Makes every session of this person look older than a recent sign-in. */
async function ageSessions(person: Person) {
	const longAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
	await id.db
		.prepare("UPDATE session SET created_at = ?, updated_at = ? WHERE user_id = ?")
		.bind(longAgo, longAgo, person.userId)
		.run();
}

async function expectNotSignedIn(attempt: { response: Response; client: string }, status: number) {
	expect(attempt.response.status).toBe(status);
	expect(cookieOf(attempt.response)).not.toContain("session_token");
	expect(await sessionOf(attempt.client, attempt.response)).toBeNull();
}

describe("adding a passkey", () => {
	it("asks for one that the browser can find by itself and that checks who is there", async () => {
		const person = await newPersonWithAPassword();
		const { options } = await askToRegister(person);

		expect(options.rp).toEqual({ id: "id.test", name: "Gateweave ID" });
		expect(options.user.name).toBe(person.email);
		expect(options.attestation).toBe("none");
		expect(options.authenticatorSelection).toMatchObject({
			residentKey: "required",
			userVerification: "required",
		});
	});

	it("keeps a passkey that holds up, and names it after the device", async () => {
		const person = await newPersonWithAPassword();
		const authenticator = new FakeAuthenticator(origin);
		const { options, cookie } = await askToRegister(person);

		const added = await id.fetch(`${origin}/api/auth/passkey/verify-registration`, {
			method: "POST",
			headers: {
				origin,
				cookie,
				"cf-connecting-ip": person.client,
				"content-type": "application/json",
				"user-agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
			},
			body: JSON.stringify({ response: authenticator.register(options) }),
		});

		expect(added.status).toBe(200);
		const [passkey] = await passkeysOf(person);
		expect(passkey).toMatchObject({
			name: "Chrome on Windows",
			userId: person.userId,
			credentialID: authenticator.credentialId,
		});
	});

	it("does not offer a device its own passkey again", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const { options } = await askToRegister(person);
		expect(options.excludeCredentials.map((credential) => credential.id)).toEqual([
			authenticator.credentialId,
		]);
	});

	it("needs someone signed in, and recently", async () => {
		const nobody = await api("/passkey/generate-register-options", { client: newClient() });
		expect(nobody.status).toBe(401);

		const person = await newPersonWithAPassword();
		const asked = await askToRegister(person);
		await ageSessions(person);

		const options = await api("/passkey/generate-register-options", person);
		expect(options.status).toBe(403);
		expect(await options.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });

		const finished = await api("/passkey/verify-registration", {
			client: person.client,
			cookie: asked.cookie,
			body: { response: new FakeAuthenticator(origin).register(asked.options) },
		});
		expect(finished.status).toBe(403);
		expect(await passkeysOf(person)).toEqual([]);
	});

	it.each<[string, Ceremony, number]>([
		["did not check who is there", { userVerified: false }, 400],
		["was made for another site", { origin: "https://elsewhere.test" }, 500],
		["was made for another relying party", { rpId: "elsewhere.test" }, 500],
		["signed another challenge", { challenge: "bm90LXRoZS1jaGFsbGVuZ2U" }, 500],
		["claims to be a sign-in", { type: "webauthn.get" }, 500],
	])("refuses a passkey that %s", async (_, ceremony, status) => {
		const person = await newPersonWithAPassword();

		const added = await tryToRegister(person, new FakeAuthenticator(origin), ceremony);

		expect(added.status).toBe(status);
		expect(await passkeysOf(person)).toEqual([]);
	});

	it("uses a challenge once", async () => {
		const person = await newPersonWithAPassword();
		const { options, cookie } = await askToRegister(person);
		const authenticator = new FakeAuthenticator(origin);
		const body = { response: authenticator.register(options) };
		const first = await api("/passkey/verify-registration", {
			client: person.client,
			cookie,
			body,
		});
		expect(first.status).toBe(200);

		const again = await api("/passkey/verify-registration", {
			client: person.client,
			cookie,
			body,
		});

		expect(again.status).toBe(400);
		expect(await passkeysOf(person)).toHaveLength(1);
	});

	it("does not finish for someone other than who started it", async () => {
		const started = await newPersonWithAPassword();
		const other = await newPersonWithAPassword();
		const { options, cookie } = await askToRegister(started);
		const challenge = cookie.replace(started.cookie, "");

		const finished = await api("/passkey/verify-registration", {
			client: other.client,
			cookie: `${other.cookie}${challenge}`,
			body: { response: new FakeAuthenticator(origin).register(options) },
		});

		expect(finished.status).toBe(401);
		expect(await passkeysOf(other)).toEqual([]);
		expect(await passkeysOf(started)).toEqual([]);
	});

	it("will not let a second person claim a passkey's id", async () => {
		const owner = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(owner);
		const thief = await newPersonWithAPassword();

		const claimed = await tryToRegister(
			thief,
			new FakeAuthenticator(origin, authenticator.credentialId),
		);

		expect(claimed.status).toBe(400);
		expect(await passkeysOf(thief)).toEqual([]);
		const { response, client } = await tryToSignIn(authenticator);
		expect((await sessionOf(client, response))?.user.id).toBe(owner.userId);
	});

	it("will not store two passkeys with one id, whatever gets past the check", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const copy = id.db
			.prepare(
				`INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
				 VALUES ('copy', 'key', ?, ?, 0, 'multiDevice', 1)`,
			)
			.bind(person.userId, authenticator.credentialId);
		await expect(copy.run()).rejects.toThrow(/UNIQUE/);
	});

	it("does not sign anyone in", async () => {
		const person = await newPersonWithAPassword();
		const added = await tryToRegister(person, undefined, {}, { createSession: true });
		expect(added.status).toBe(400);
		expect(cookieOf(added)).not.toContain("session_token");
		expect(await passkeysOf(person)).toEqual([]);
	});

	it("limits how long a name can be", async () => {
		const person = await newPersonWithAPassword();
		const added = await tryToRegister(person, undefined, {}, { name: "x".repeat(101) });
		expect(added.status).toBe(400);
		expect(await added.json()).toMatchObject({ code: "INVALID_PASSKEY_NAME" });
		expect(await passkeysOf(person)).toEqual([]);
	});
});

describe("signing in with a passkey", () => {
	it("asks for any passkey of this site, with a check of who is there", async () => {
		const { options } = await askToSignIn(newClient());
		expect(options.rpId).toBe("id.test");
		expect(options.userVerification).toBe("required");
		// Naming passkeys here would tell a stranger who has one.
		expect(options.allowCredentials ?? []).toEqual([]);
	});

	it("signs in the person it belongs to", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);

		const { response, client } = await tryToSignIn(authenticator);

		expect(response.status).toBe(200);
		expect((await sessionOf(client, response))?.user.id).toBe(person.userId);
	});

	it("works for someone with no other way to sign in", async () => {
		const person = await newPersonWithOnlyACode();
		const { authenticator } = await withPasskey(person);

		const { response, client } = await tryToSignIn(authenticator);

		expect((await sessionOf(client, response))?.user.id).toBe(person.userId);
	});

	it("keeps counting, and refuses a counter that goes backwards", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const first = await tryToSignIn(authenticator, { counter: 10 });
		expect(first.response.status).toBe(200);

		await expectNotSignedIn(await tryToSignIn(authenticator, { counter: 5 }), 400);
	});

	it.each<[string, Ceremony, number]>([
		["did not check who is there", { userVerified: false }, 401],
		["was made for another site", { origin: "https://elsewhere.test" }, 400],
		["was made for another relying party", { rpId: "elsewhere.test" }, 400],
		["signed another challenge", { challenge: "bm90LXRoZS1jaGFsbGVuZ2U" }, 400],
		["claims to be a registration", { type: "webauthn.create" }, 400],
	])("refuses an answer that %s", async (_, ceremony, status) => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);

		await expectNotSignedIn(await tryToSignIn(authenticator, ceremony), status);
	});

	it("refuses a passkey nobody has registered", async () => {
		await expectNotSignedIn(await tryToSignIn(new FakeAuthenticator(origin)), 401);
	});

	it("refuses a signature from another key", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const impostor = new FakeAuthenticator(origin, authenticator.credentialId);

		await expectNotSignedIn(await tryToSignIn(impostor), 400);
	});

	it("takes an answer once", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const client = newClient();
		const { options, cookie } = await askToSignIn(client);
		const body = { response: authenticator.signIn(options) };
		const first = await api("/passkey/verify-authentication", { client, cookie, body });
		expect(first.status).toBe(200);

		const again = await api("/passkey/verify-authentication", { client, cookie, body });

		await expectNotSignedIn({ response: again, client }, 400);
	});

	it("does not take a challenge meant for adding a passkey", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const { options, cookie } = await askToRegister(person);

		const response = await api("/passkey/verify-authentication", {
			client: person.client,
			cookie,
			body: { response: authenticator.signIn(options) },
		});

		expect(response.status).toBe(400);
	});

	it("carries on to the app someone was on their way to", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const host = "passkey-way.apps.test";
		const redirectUri = `https://${host}/callback`;
		const made = appRow({ app: "passkey-way", name: "On the way", redirectUris: [redirectUri] });
		await id.db.prepare(insertStatement(made.row)).run();
		const client = newClient();
		const query = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid",
			state: "the-state",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		});
		const authorized = await id.fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
			headers: { "cf-connecting-ip": client },
		});
		const { url } = (await authorized.json()) as { url: string };
		const signedQuery = new URL(url, origin).search.slice(1);
		expect(signedQuery).toContain("sig=");
		const { options, cookie } = await askToSignIn(client);

		const response = await api("/passkey/verify-authentication", {
			client,
			cookie,
			body: { response: authenticator.signIn(options), oauth_query: signedQuery },
		});

		expect(response.status).toBe(200);
		const answer = (await response.json()) as { redirect?: boolean; url?: string };
		expect(answer.redirect).toBe(true);
		// Someone with no group or rule against them, on an app with none, gets what the app asked for.
		const back = new URL(answer.url ?? "", origin);
		expect(back.origin + back.pathname).toBe(redirectUri);
		expect(back.searchParams.get("state")).toBe("the-state");
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	it("asks someone whose only way in is a passkey for no password on the way to an app", async () => {
		const person = await newPersonWithOnlyACode();
		const { authenticator } = await withPasskey(person);
		const redirectUri = "https://passkey-only.apps.test/callback";
		const made = appRow({ app: "passkey-only", name: "Only", redirectUris: [redirectUri] });
		await id.db.prepare(insertStatement(made.row)).run();
		const client = newClient();
		const query = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid",
			state: "the-state",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		});
		const authorized = await id.fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
			headers: { "cf-connecting-ip": client },
		});
		const { url } = (await authorized.json()) as { url: string };
		const { options, cookie } = await askToSignIn(client);

		const response = await api("/passkey/verify-authentication", {
			client,
			cookie,
			body: {
				response: authenticator.signIn(options),
				oauth_query: new URL(url, origin).search.slice(1),
			},
		});

		expect(response.status).toBe(200);
		const answer = (await response.json()) as { url?: string };
		const back = new URL(answer.url ?? "", origin);
		expect(back.origin + back.pathname).toBe(redirectUri);
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	it("still asks for a password of someone with no way back in, whatever others have", async () => {
		await withPasskey(await newPersonWithOnlyACode());
		const person = await newPersonWithOnlyACode();
		const redirectUri = "https://passkey-none.apps.test/callback";
		const made = appRow({ app: "passkey-none", name: "None", redirectUris: [redirectUri] });
		await id.db.prepare(insertStatement(made.row)).run();
		const query = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid",
			state: "the-state",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		});

		const authorized = await id.fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
			headers: { "cf-connecting-ip": person.client, cookie: person.cookie },
		});

		const { url } = (await authorized.json()) as { url: string };
		expect(new URL(url, origin).pathname).toBe("/welcome");
	});

	it("does not skip the check of who may use the app", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const host = "passkey-refused.apps.test";
		const redirectUri = `https://${host}/callback`;
		const made = appRow({
			app: "passkey-refused",
			name: "Refused",
			redirectUris: [redirectUri],
		});
		await id.db.prepare(insertStatement(made.row)).run();
		await id.db
			.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
			.bind(person.userId)
			.run();
		const client = newClient();
		const query = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid",
			state: "the-state",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		});
		const authorized = await id.fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
			headers: { "cf-connecting-ip": client },
		});
		const { url } = (await authorized.json()) as { url: string };
		const { options, cookie } = await askToSignIn(client);

		const response = await api("/passkey/verify-authentication", {
			client,
			cookie,
			body: {
				response: authenticator.signIn(options),
				oauth_query: new URL(url, origin).search.slice(1),
			},
		});

		const answer = (await response.json()) as { url?: string };
		const next = new URL(answer.url ?? "", origin);
		expect(next.origin).toBe(origin);
		expect(next.pathname).toBe("/no-access");
		expect(next.searchParams.has("code")).toBe(false);
	});
});

describe("naming a passkey", () => {
	it("renames their own", async () => {
		const person = await newPersonWithAPassword();
		const { passkeyId } = await withPasskey(person);

		const renamed = await api("/passkey/update-passkey", {
			...person,
			body: { id: passkeyId, name: "  Work laptop  " },
		});

		expect(renamed.status).toBe(200);
		expect((await passkeysOf(person))[0]?.name).toBe("Work laptop");
	});

	it("refuses a name that is empty or too long", async () => {
		const person = await newPersonWithAPassword();
		const { passkeyId } = await withPasskey(person);
		const before = (await passkeysOf(person))[0]?.name;

		for (const name of ["   ", "x".repeat(101)]) {
			const renamed = await api("/passkey/update-passkey", {
				...person,
				body: { id: passkeyId, name },
			});
			expect(renamed.status).toBe(400);
		}
		expect((await passkeysOf(person))[0]?.name).toBe(before);
	});

	it("does not reach someone else's", async () => {
		const owner = await newPersonWithAPassword();
		const { passkeyId } = await withPasskey(owner);
		const other = await newPersonWithAPassword();
		const before = (await passkeysOf(owner))[0]?.name;

		const renamed = await api("/passkey/update-passkey", {
			...other,
			body: { id: passkeyId, name: "Mine now" },
		});

		expect(renamed.status).not.toBe(200);
		expect((await passkeysOf(owner))[0]?.name).toBe(before);
	});
});

describe("removing a passkey", () => {
	function remove(person: Person, passkeyId: string) {
		return api("/account/remove-passkey", { ...person, body: { id: passkeyId } });
	}

	it("removes it when a password is left, and it no longer signs in", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator, passkeyId } = await withPasskey(person);

		const removed = await remove(person, passkeyId);

		expect(removed.status).toBe(200);
		expect(await passkeysOf(person)).toEqual([]);
		await expectNotSignedIn(await tryToSignIn(authenticator), 401);
	});

	it("removes it when another passkey is left", async () => {
		const person = await newPersonWithOnlyACode();
		const { passkeyId } = await withPasskey(person);
		const { passkeyId: other } = await withPasskey(person);

		expect((await remove(person, passkeyId)).status).toBe(200);
		expect((await passkeysOf(person)).map((passkey) => passkey.id)).toEqual([other]);
	});

	it("refuses to remove the last way to sign in", async () => {
		const person = await newPersonWithOnlyACode();
		const { authenticator, passkeyId } = await withPasskey(person);

		const removed = await remove(person, passkeyId);

		expect(removed.status).toBe(400);
		expect(await removed.json()).toMatchObject({ code: "LAST_WAY_TO_SIGN_IN" });
		expect(await passkeysOf(person)).toHaveLength(1);
		const { response } = await tryToSignIn(authenticator);
		expect(response.status).toBe(200);
	});

	it("does not let two removals at once take the last two", async () => {
		const person = await newPersonWithOnlyACode();
		const { passkeyId: first } = await withPasskey(person);
		const { passkeyId: second } = await withPasskey(person);

		const answers = await Promise.all([remove(person, first), remove(person, second)]);

		expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
		expect(await passkeysOf(person)).toHaveLength(1);
	});

	it("counts GitHub as a way to sign in", async () => {
		const gitHub: GitHubPerson = {
			id: 900_001,
			login: "passkey-person",
			name: "Grace Hopper",
			emails: [{ email: "passkey-github@example.com", primary: true, verified: true }],
		};
		const client = newClient();
		const started = await api("/sign-in/social", {
			client,
			body: { provider: "github", callbackURL: "/account" },
		});
		const { url } = (await started.json()) as { url: string };
		const state = new URL(url).searchParams.get("state") ?? "";
		const back = await id.fetch(
			`${origin}/api/auth/callback/github?${new URLSearchParams({ code: gitHubCode(gitHub), state })}`,
			{ headers: { "cf-connecting-ip": client, cookie: cookieOf(started) } },
		);
		const cookie = cookieOf(back);
		const session = (await (await api("/get-session", { client, cookie })).json()) as {
			user: { id: string; email: string };
		};
		const person = { email: session.user.email, client, cookie, userId: session.user.id };
		const { passkeyId } = await withPasskey(person);

		expect((await remove(person, passkeyId)).status).toBe(200);
	});

	it("does not count a GitHub link where GitHub sign-in is off", async () => {
		const noGitHub = await startId(origin, { github: false });
		try {
			const person = await newPersonWithOnlyACode(noGitHub);
			await noGitHub.db
				.prepare(
					`INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
					 VALUES ('linked', '900002', 'github', ?, 0, 0)`,
				)
				.bind(person.userId)
				.run();
			const authenticator = new FakeAuthenticator(origin);
			const asked = await api("/passkey/generate-register-options", person, noGitHub);
			const added = await api(
				"/passkey/verify-registration",
				{
					client: person.client,
					cookie: withCookie(person.cookie, asked),
					body: { response: authenticator.register((await asked.json()) as { challenge: string }) },
				},
				noGitHub,
			);
			const { id: passkeyId } = (await added.json()) as { id: string };

			const removed = await api(
				"/account/remove-passkey",
				{ ...person, body: { id: passkeyId } },
				noGitHub,
			);

			expect(removed.status).toBe(400);
			expect(await removed.json()).toMatchObject({ code: "LAST_WAY_TO_SIGN_IN" });
		} finally {
			await noGitHub.dispose();
		}
	});

	it("needs a recent sign-in", async () => {
		const person = await newPersonWithAPassword();
		const { passkeyId } = await withPasskey(person);
		await ageSessions(person);

		const removed = await remove(person, passkeyId);

		expect(removed.status).toBe(403);
		expect(await removed.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
	});

	it("does not reach someone else's", async () => {
		const owner = await newPersonWithAPassword();
		const { passkeyId } = await withPasskey(owner);
		const other = await newPersonWithAPassword();

		const removed = await remove(other, passkeyId);

		expect(removed.status).toBe(404);
		expect(await passkeysOf(owner)).toHaveLength(1);
	});

	it("needs someone signed in", async () => {
		const removed = await api("/account/remove-passkey", {
			client: newClient(),
			body: { id: "any" },
		});
		expect(removed.status).toBe(401);
	});

	it("has no other way in that skips those checks", async () => {
		const person = await newPersonWithOnlyACode();
		const { passkeyId } = await withPasskey(person);

		const removed = await api("/passkey/delete-passkey", { ...person, body: { id: passkeyId } });

		expect(removed.status).toBe(404);
		expect(await passkeysOf(person)).toHaveLength(1);
	});
});

describe("the audit log", () => {
	it("records adding a passkey, signing in with it and removing it", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator, passkeyId } = await withPasskey(person);
		await id.auditEventRecorded(person.userId, { type: "passkey_added", ip: person.client });

		const { response, client } = await tryToSignIn(authenticator);
		expect(response.status).toBe(200);
		await id.auditEventRecorded(person.userId, {
			type: "sign_in",
			detail: "passkey",
			ip: client,
		});

		const removed = await api("/account/remove-passkey", { ...person, body: { id: passkeyId } });
		expect(removed.status).toBe(200);
		await id.auditEventRecorded(person.userId, { type: "passkey_removed", ip: person.client });
	});

	it("records a failed sign-in against the passkey's owner", async () => {
		const person = await newPersonWithAPassword();
		const { authenticator } = await withPasskey(person);
		const { response, client } = await tryToSignIn(authenticator, { userVerified: false });
		expect(response.status).toBeGreaterThanOrEqual(400);
		await id.auditEventRecorded(person.userId, {
			type: "sign_in_failed",
			detail: "passkey",
			ip: client,
		});
	});

	it("records no removal that was refused", async () => {
		const person = await newPersonWithOnlyACode();
		const { passkeyId } = await withPasskey(person);
		const refused = await api("/account/remove-passkey", { ...person, body: { id: passkeyId } });
		expect(refused.status).toBe(400);
		// Something later, by the same path.
		await api("/change-password", {
			...person,
			body: { currentPassword: "none", newPassword: "another-long-password" },
		});
		const { authenticator } = await withPasskey(person);
		await tryToSignIn(authenticator);
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "passkey" });
		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "passkey_removed")).toEqual([]);
	});
});

describe("how often", () => {
	it("limits asking to sign in from one address", async () => {
		const client = newClient();
		const statuses: number[] = [];
		for (let i = 0; i < 62; i++) {
			const response = await api("/passkey/generate-authenticate-options", { client });
			statuses.push(response.status);
		}
		expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
	});

	it("limits answers from one address", async () => {
		const client = newClient();
		const statuses: number[] = [];
		for (let i = 0; i < 32; i++) {
			const response = await api("/passkey/verify-authentication", {
				client,
				body: { response: {} },
			});
			statuses.push(response.status);
		}
		expect(statuses.at(0)).toBe(400);
		expect(statuses.at(-1)).toBe(429);
	});

	it("limits removing passkeys from one address", async () => {
		const client = newClient();
		const statuses: number[] = [];
		for (let i = 0; i < 22; i++) {
			const response = await api("/account/remove-passkey", { client, body: { id: "any" } });
			statuses.push(response.status);
		}
		expect(statuses.at(-1)).toBe(429);
	});
});

describe("a deployment with no address set", () => {
	it("has no passkeys, since a passkey is bound to an address for good", async () => {
		const unpinned = await startId(origin, { pinned: false, oidc: false });
		try {
			const asked = await api(
				"/passkey/generate-authenticate-options",
				{ client: newClient() },
				unpinned,
			);
			expect(asked.status).toBe(404);
			const page = await unpinned.fetch(`${origin}/login`);
			expect(await page.text()).not.toContain("Use a passkey");
		} finally {
			await unpinned.dispose();
		}
	});
});

describe("the sign-in page", () => {
	it("offers a passkey, in the button and in the browser's list of addresses", async () => {
		const page = await id.fetch(`${origin}/login`);
		const html = await page.text();
		expect(html).toContain("Use a passkey");
		expect(html).toMatch(/autoComplete="email webauthn"|autocomplete="email webauthn"/);
	});
});
