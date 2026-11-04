import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../scripts/app-row";
import { removeTwoFactorStatements, twoFactorStateQuery } from "../scripts/two-factor-row";
import { gitHubCode, startId } from "./id-worker";
import { totp, wrongCode } from "./totp";

// Two-factor sign-in through the public routes of the built Worker, with an authenticator of its own
// (./totp) and a real OIDC client library for what an app sees. What the pages do with it is in e2e/.

const origin = "https://id.test";
const issuer = new URL(origin);
const PASSWORD = "a-long-password-for-tests";
const SCOPE = "openid profile email offline_access";

let id: Awaited<ReturnType<typeof startId>>;
let as: oauth.AuthorizationServer;

const fromApp = {
	[oauth.customFetch]: ((input, init) =>
		id.fetch(input as string, {
			...init,
			headers: {
				...Object.fromEntries(new Headers(init?.headers)),
				"cf-connecting-ip": "198.51.100.1",
			},
		})) as typeof fetch,
};

beforeAll(async () => {
	id = await startId(origin, { github: true });
	as = await oauth.processDiscoveryResponse(
		issuer,
		await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp }),
	);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each request comes from an address of its own, so that rate limits stay out of the way. */
function newClient() {
	clients += 1;
	return `203.0.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
}

function api(path: string, { cookie, body }: { cookie?: string; body?: object } = {}) {
	return id.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
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

interface Person {
	email: string;
	cookie: string;
	userId: string;
}

let people = 0;

async function newPersonWithOnlyACode(): Promise<Person> {
	const email = `two-factor-${++people}@example.com`;
	await api("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	return { email, cookie: cookieOf(entered), userId: user.id };
}

async function newPerson(): Promise<Person> {
	const person = await newPersonWithOnlyACode();
	const chosen = await api("/account/first-password", {
		cookie: person.cookie,
		body: { newPassword: PASSWORD },
	});
	expect(chosen.status).toBe(200);
	return person;
}

interface Enrolled {
	uri: URL;
	key: string;
	recoveryCodes: string[];
}

/** Asks to turn it on, and stops short of the code that confirms it. */
async function askToEnrol(person: Person): Promise<Enrolled> {
	const asked = await api("/two-factor/enable", {
		cookie: person.cookie,
		body: { password: PASSWORD },
	});
	expect(asked.status).toBe(200);
	const { totpURI, backupCodes } = (await asked.json()) as {
		totpURI: string;
		backupCodes: string[];
	};
	const uri = new URL(totpURI);
	return { uri, key: uri.searchParams.get("secret") ?? "", recoveryCodes: backupCodes };
}

/** Turns it on. The session is replaced in doing so, which `person` follows. */
async function enrol(person: Person): Promise<Enrolled> {
	const enrolled = await askToEnrol(person);
	const confirmed = await api("/two-factor/verify-totp", {
		cookie: person.cookie,
		body: { code: totp(enrolled.key) },
	});
	expect(confirmed.status).toBe(200);
	person.cookie = cookieOf(confirmed);
	return enrolled;
}

/** The first step of signing in. What comes back is a challenge, if it worked and a code is owed. */
async function givePassword(person: Person, body: object = {}) {
	const response = await api("/sign-in/email", {
		body: { email: person.email, password: PASSWORD, ...body },
	});
	return { response, challenge: cookieOf(response), body: await response.clone().json() };
}

function enterCode(challenge: string, code: string, body: object = {}) {
	return api("/two-factor/verify-totp", { cookie: challenge, body: { code, ...body } });
}

function enterRecoveryCode(challenge: string, code: string, body: object = {}) {
	return api("/two-factor/verify-backup-code", { cookie: challenge, body: { code, ...body } });
}

async function sessionOf(cookie: string) {
	const reply = await api("/get-session", { cookie });
	return (await reply.json()) as {
		user: { id: string; email: string; twoFactorEnabled: boolean };
	} | null;
}

async function errorCode(response: Response) {
	return ((await response.clone().json()) as { code?: string }).code;
}

async function count(sql: string, ...bindings: string[]) {
	const row = await id.db
		.prepare(sql)
		.bind(...bindings)
		.first<{ n: number }>();
	return row?.n;
}

const sessionsOf = (person: Person) =>
	count("SELECT count(*) AS n FROM session WHERE user_id = ?", person.userId);

/** Everything the provider has made a code from, for anyone. Its rows name the kind in their value. */
const authorizationCodes = () =>
	count("SELECT count(*) AS n FROM verification WHERE value LIKE '%authorization_code%'");

function twoFactorRow(person: Person) {
	return id.db
		.prepare("SELECT secret, backup_codes, verified FROM two_factor WHERE user_id = ?")
		.bind(person.userId)
		.first<{ secret: string; backup_codes: string; verified: number }>();
}

let apps = 0;

async function newApp() {
	const host = `two-factor-${++apps}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const made = appRow({
		app: `two-factor-app-${apps}`,
		name: `App ${apps}`,
		redirectUris: [redirectUri],
		backchannelLogoutUri: `https://${host}/logout`,
	});
	await id.db.prepare(insertStatement(made.row)).run();
	return {
		host,
		redirectUri,
		clientId: made.clientId,
		client: { client_id: made.clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(made.clientSecret),
	};
}

type App = Awaited<ReturnType<typeof newApp>>;

/** A browser arriving at the authorization endpoint, as an app would send it there. */
async function authorize(app: App, cookie?: string, params: Record<string, string> = {}) {
	const state = oauth.generateRandomState();
	const nonce = oauth.generateRandomNonce();
	const verifier = oauth.generateRandomCodeVerifier();
	const url = new URL(as.authorization_endpoint ?? "");
	url.search = new URLSearchParams({
		client_id: app.clientId,
		redirect_uri: app.redirectUri,
		response_type: "code",
		scope: SCOPE,
		state,
		nonce,
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		...params,
	}).toString();
	const response = await id.fetch(url, {
		headers: { "cf-connecting-ip": newClient(), ...(cookie && { cookie }) },
	});
	// Miniflare's fetch says `sec-fetch-mode: cors` whatever it is told, and the provider answers that
	// with where to go where a browser's navigation gets a redirect.
	const { url: target } = (await response.clone().json()) as { url: string };
	const location = new URL(target, origin);
	return { location, state, nonce, verifier, oauthQuery: location.search.slice(1) };
}

type Authorized = Awaited<ReturnType<typeof authorize>>;

/** What an app's server does with where the browser ended up. */
async function exchange(app: App, authorized: Authorized, location: URL) {
	const params = oauth.validateAuthResponse(as, app.client, location, authorized.state);
	const response = await oauth.authorizationCodeGrantRequest(
		as,
		app.client,
		app.auth,
		params,
		app.redirectUri,
		authorized.verifier,
		fromApp,
	);
	const tokens = await oauth.processAuthorizationCodeResponse(as, app.client, response, {
		expectedNonce: authorized.nonce,
		requireIdToken: true,
	});
	const claims = oauth.getValidatedIdTokenClaims(tokens);
	if (!claims) throw new Error("No ID token");
	return claims;
}

function logoutsTo(app: App) {
	return id.outboundBodies.filter(({ url }) => url === `https://${app.host}/logout`);
}

describe("an authenticator's codes", () => {
	it("are what RFC 6238 says they are, so that these tests hold ID to the standard", () => {
		// The test vector for SHA-1 in the RFC's appendix, whose key is this text in base32.
		const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		expect(totp(key, { at: 59_000, digits: 8 })).toBe("94287082");
		expect(totp(key, { at: 1_111_111_109_000, digits: 8 })).toBe("07081804");
	});
});

describe("turning it on", () => {
	it("takes the person's password", async () => {
		const person = await newPerson();
		const refused = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: "not-the-password" },
		});
		expect(refused.status).toBe(400);
		expect(await twoFactorRow(person)).toBeNull();
	});

	it("takes a session", async () => {
		const refused = await api("/two-factor/enable", { body: { password: PASSWORD } });
		expect(refused.status).toBe(401);
	});

	it("is refused to someone with no password, whom it would not protect", async () => {
		const person = await newPersonWithOnlyACode();
		const refused = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(refused.status).toBe(400);
		expect(await twoFactorRow(person)).toBeNull();
	});

	it("does not offer codes by email", async () => {
		const person = await newPerson();
		const refused = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD, method: "otp" },
		});
		expect(refused.status).toBe(400);
		expect((await sessionOf(person.cookie))?.user.twoFactorEnabled).toBe(false);
	});

	it("hands out what an authenticator app expects", async () => {
		const person = await newPerson();
		const { uri, recoveryCodes } = await askToEnrol(person);
		expect(uri.protocol).toBe("otpauth:");
		expect(uri.host).toBe("totp");
		expect(decodeURIComponent(uri.pathname)).toBe(`/Gateweave ID:${person.email}`);
		expect(uri.searchParams.get("issuer")).toBe("Gateweave ID");
		expect(uri.searchParams.get("digits")).toBe("6");
		expect(uri.searchParams.get("period")).toBe("30");
		expect(new Set(recoveryCodes).size).toBe(10);
	});

	it("changes nothing until a code shows that the authenticator works", async () => {
		const person = await newPerson();
		const { key } = await askToEnrol(person);

		// Someone who gives up here must not be locked out by an app they never finished setting up.
		const beforeConfirming = await givePassword(person);
		expect(beforeConfirming.body.twoFactorRedirect).toBeUndefined();
		expect(await sessionOf(beforeConfirming.challenge)).not.toBeNull();

		const wrong = await enterCode(person.cookie, wrongCode(key));
		expect(wrong.status).toBe(401);
		expect((await sessionOf(person.cookie))?.user.twoFactorEnabled).toBe(false);
		expect((await givePassword(person)).body.twoFactorRedirect).toBeUndefined();

		const right = await enterCode(person.cookie, totp(key));
		expect(right.status).toBe(200);
		expect((await sessionOf(cookieOf(right)))?.user.twoFactorEnabled).toBe(true);
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});

	it("can start over before it is confirmed, and the old key stops counting", async () => {
		const person = await newPerson();
		const first = await askToEnrol(person);
		const second = await askToEnrol(person);
		expect(second.key).not.toBe(first.key);
		expect((await enterCode(person.cookie, totp(first.key))).status).toBe(401);
		expect((await enterCode(person.cookie, totp(second.key))).status).toBe(200);
	});

	it("cannot replace an authenticator that is already confirmed", async () => {
		const person = await newPerson();
		await enrol(person);
		const again = await api("/two-factor/enable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(again.status).toBe(400);
		expect(await errorCode(again)).toBe("TOTP_ALREADY_ENABLED");
	});

	it("keeps neither the key nor the recovery codes readable in the database", async () => {
		const person = await newPerson();
		const { key, recoveryCodes } = await enrol(person);
		const row = await twoFactorRow(person);
		expect(row?.verified).toBe(1);
		expect(row?.secret).not.toContain(key);
		for (const code of recoveryCodes) expect(row?.backup_codes).not.toContain(code);
	});

	it.each(["/two-factor/get-totp-uri", "/two-factor/send-otp", "/two-factor/verify-otp"])(
		"does not offer %s",
		async (path) => {
			const person = await newPerson();
			await enrol(person);
			const response = await api(path, {
				cookie: person.cookie,
				body: { password: PASSWORD, code: "123456" },
			});
			expect(response.status).toBe(404);
		},
	);
});

describe("signing in with a password", () => {
	it("leaves nobody signed in until the code", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const before = await sessionsOf(person);

		const { response, challenge, body } = await givePassword(person);
		expect(response.status).toBe(200);
		expect(body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect(await sessionOf(challenge)).toBeNull();
		expect(await sessionsOf(person)).toBe(before);

		const entered = await enterCode(challenge, totp(key));
		expect(entered.status).toBe(200);
		expect((await sessionOf(cookieOf(entered)))?.user.email).toBe(person.email);
	});

	it("is not let in by a wrong password, and is told nothing about a code", async () => {
		const person = await newPerson();
		await enrol(person);
		const { response, body } = await givePassword(person, { password: "not-the-password" });
		expect(response.status).toBe(401);
		expect(body.twoFactorRedirect).toBeUndefined();
	});

	it("refuses a wrong code, and still takes the right one", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const { challenge } = await givePassword(person);

		const wrong = await enterCode(challenge, wrongCode(key));
		expect(wrong.status).toBe(401);
		expect(await errorCode(wrong)).toBe("INVALID_CODE");
		expect(cookieOf(wrong)).not.toContain("session_token");

		expect((await enterCode(challenge, totp(key))).status).toBe(200);
	});

	it("wants a challenge that a right password made", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const noChallenge = await enterCode("", totp(key));
		expect(noChallenge.status).toBe(401);
		expect(await errorCode(noChallenge)).toBe("INVALID_TWO_FACTOR_COOKIE");
	});

	it("spends a challenge once", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const { challenge } = await givePassword(person);
		expect((await enterCode(challenge, totp(key))).status).toBe(200);

		const again = await enterCode(challenge, totp(key, { steps: 1 }));
		expect(again.status).toBe(401);
		expect(await errorCode(again)).toBe("INVALID_TWO_FACTOR_COOKIE");
	});

	it("takes a code once, however long it would stay good", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const code = totp(key);
		expect((await enterCode((await givePassword(person)).challenge, code)).status).toBe(200);

		const again = await enterCode((await givePassword(person)).challenge, code);
		expect(again.status).toBe(401);
		expect(await errorCode(again)).toBe("INVALID_CODE");
		expect(cookieOf(again)).not.toContain("session_token");

		// The app's next code is what the person has to wait for.
		const next = await enterCode((await givePassword(person)).challenge, totp(key, { steps: 1 }));
		expect(next.status).toBe(200);
	});

	it("takes a code once when two requests send it together", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const code = totp(key);
		const challenges = [await givePassword(person), await givePassword(person)];
		const statuses = await Promise.all(
			challenges.map(({ challenge }) => enterCode(challenge, code).then(({ status }) => status)),
		);
		expect(statuses.sort()).toEqual([200, 401]);
	});

	it("keeps one person's used code from counting against another's", async () => {
		const someone = await newPerson();
		const other = await newPerson();
		const { key } = await enrol(someone);
		const { key: otherKey } = await enrol(other);
		const code = totp(key);
		expect((await enterCode((await givePassword(someone)).challenge, code)).status).toBe(200);
		expect((await enterCode((await givePassword(other)).challenge, totp(otherKey))).status).toBe(
			200,
		);
	});

	it("does not remember a device", async () => {
		const person = await newPerson();
		const { key, recoveryCodes } = await enrol(person);
		const { challenge } = await givePassword(person);

		const remember = await enterCode(challenge, totp(key), { trustDevice: true });
		expect(remember.status).toBe(400);
		expect(remember.headers.getSetCookie().join()).not.toContain("trust_device");
		const rememberWithRecovery = await enterRecoveryCode(challenge, recoveryCodes[0] ?? "", {
			trustDevice: true,
		});
		expect(rememberWithRecovery.status).toBe(400);
		expect(rememberWithRecovery.headers.getSetCookie().join()).not.toContain("trust_device");

		// A person who is told no can still sign in, and nothing was spent.
		expect((await enterCode(challenge, totp(key))).status).toBe(200);
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});

	it("does not spend a recovery code without signing in", async () => {
		const person = await newPerson();
		const { recoveryCodes } = await enrol(person);
		const code = recoveryCodes[0] ?? "";
		const { challenge } = await givePassword(person);
		const refused = await enterRecoveryCode(challenge, code, { disableSession: true });
		expect(refused.status).toBe(400);
		expect((await enterRecoveryCode(challenge, code)).status).toBe(200);
	});

	it("gives five tries at one challenge, and then wants the password again", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const { challenge } = await givePassword(person);
		for (let attempt = 0; attempt < 5; attempt++) {
			const wrong = await enterCode(challenge, wrongCode(key, 100 + attempt));
			expect(wrong.status).toBe(401);
		}
		const tooMany = await enterCode(challenge, totp(key));
		expect(tooMany.status).toBe(400);
		expect(await errorCode(tooMany)).toBe("TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE");
		expect(cookieOf(tooMany)).not.toContain("session_token");

		const fresh = await givePassword(person);
		expect((await enterCode(fresh.challenge, totp(key, { steps: 1 }))).status).toBe(200);
	});

	it("locks out codes for a while after ten wrong ones in a row, across challenges", async () => {
		const person = await newPerson();
		const { key, recoveryCodes } = await enrol(person);
		for (const round of [0, 1]) {
			const { challenge } = await givePassword(person);
			for (let attempt = 0; attempt < 5; attempt++) {
				await enterCode(challenge, wrongCode(key, 200 + round * 10 + attempt));
			}
		}
		const { challenge } = await givePassword(person);
		const locked = await enterCode(challenge, totp(key));
		expect(locked.status).toBe(429);
		expect(await errorCode(locked)).toBe("ACCOUNT_TEMPORARILY_LOCKED");
		// A recovery code is the same factor to someone guessing.
		const stillLocked = await enterRecoveryCode(challenge, recoveryCodes[0] ?? "");
		expect(stillLocked.status).toBe(429);
	});

	it("still asks after a password reset by email", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		await api("/request-password-reset", {
			body: { email: person.email, redirectTo: "/reset-password" },
		});
		let token = "";
		await vi.waitFor(async () => {
			const mail = (await id.emails()).find(
				({ to, text }) => to === person.email && text.includes("reset-password"),
			);
			token = /reset-password\/([^?\s]+)/.exec(mail?.text ?? "")?.[1] ?? "";
			expect(token).not.toBe("");
		});
		const newPassword = "another-long-password-for-tests";
		const reset = await api("/reset-password", { body: { token, newPassword } });
		expect(reset.status).toBe(200);
		expect(cookieOf(reset)).not.toContain("session_token");

		const { challenge, body } = await givePassword(person, { password: newPassword });
		expect(body.twoFactorRedirect).toBe(true);
		expect(await sessionOf(challenge)).toBeNull();
		expect((await enterCode(challenge, totp(key))).status).toBe(200);
	});

	it("is the only way in that asks: GitHub has its own sign-in", async () => {
		const address = `two-factor-github-${++people}@example.com`;
		const someone = {
			id: 7000 + people,
			login: `someone-${people}`,
			emails: [{ email: address, primary: true, verified: true }],
		};
		async function signInWithGitHub() {
			const started = await api("/sign-in/social", {
				body: { provider: "github", callbackURL: "/account" },
			});
			const { url } = (await started.json()) as { url: string };
			const state = new URL(url).searchParams.get("state") ?? "";
			return id.fetch(
				`${origin}/api/auth/callback/github?${new URLSearchParams({ code: gitHubCode(someone), state })}`,
				{ headers: { "cf-connecting-ip": newClient(), cookie: cookieOf(started) } },
			);
		}
		const first = await signInWithGitHub();
		const { user } = (await sessionOf(cookieOf(first))) ?? {};
		const person = { email: address, cookie: cookieOf(first), userId: user?.id ?? "" };
		expect(
			(
				await api("/account/first-password", {
					cookie: person.cookie,
					body: { newPassword: PASSWORD },
				})
			).status,
		).toBe(200);
		await enrol(person);

		const again = await signInWithGitHub();
		expect((await sessionOf(cookieOf(again)))?.user.id).toBe(person.userId);
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});
});

describe("recovery codes", () => {
	it("have nothing in them that looks like something else, being read off paper", async () => {
		const { recoveryCodes } = await enrol(await newPerson());
		expect(new Set(recoveryCodes).size).toBe(10);
		for (const code of recoveryCodes) {
			expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
		}
	});

	it("each sign someone in once", async () => {
		const person = await newPerson();
		const { recoveryCodes } = await enrol(person);
		const code = recoveryCodes[0] ?? "";

		const used = await enterRecoveryCode((await givePassword(person)).challenge, code);
		expect(used.status).toBe(200);
		expect((await sessionOf(cookieOf(used)))?.user.email).toBe(person.email);

		const again = await enterRecoveryCode((await givePassword(person)).challenge, code);
		expect(again.status).toBe(401);
		expect(await errorCode(again)).toBe("INVALID_BACKUP_CODE");

		const another = await enterRecoveryCode(
			(await givePassword(person)).challenge,
			recoveryCodes[1] ?? "",
		);
		expect(another.status).toBe(200);
	});

	it("are replaced only with the password, and the old ones stop working", async () => {
		const person = await newPerson();
		const { recoveryCodes } = await enrol(person);
		const refused = await api("/two-factor/generate-backup-codes", {
			cookie: person.cookie,
			body: { password: "not-the-password" },
		});
		expect(refused.status).toBe(400);
		expect(
			(await enterRecoveryCode((await givePassword(person)).challenge, recoveryCodes[0] ?? ""))
				.status,
		).toBe(200);

		const replaced = await api("/two-factor/generate-backup-codes", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(replaced.status).toBe(200);
		const { backupCodes } = (await replaced.json()) as { backupCodes: string[] };
		expect(
			(await enterRecoveryCode((await givePassword(person)).challenge, recoveryCodes[1] ?? ""))
				.status,
		).toBe(401);
		expect(
			(await enterRecoveryCode((await givePassword(person)).challenge, backupCodes[0] ?? ""))
				.status,
		).toBe(200);
	});
});

describe("on the way to an app", () => {
	it("gets the app nothing for a password alone", async () => {
		const app = await newApp();
		const person = await newPerson();
		await enrol(person);
		const authorized = await authorize(app);
		expect(authorized.location.pathname).toBe("/login");
		const before = await authorizationCodes();

		const { response, body, challenge } = await givePassword(person, {
			oauth_query: authorized.oauthQuery,
		});
		expect(response.status).toBe(200);
		expect(body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect(response.headers.get("location")).toBeNull();
		expect(await response.clone().text()).not.toContain(app.redirectUri);
		expect(await sessionOf(challenge)).toBeNull();
		expect(await authorizationCodes()).toBe(before);
	});

	it("carries on to the app once the code is right, and the ID token checks out", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { key } = await enrol(person);
		const authorized = await authorize(app);
		const { challenge } = await givePassword(person, { oauth_query: authorized.oauthQuery });

		const wrong = await enterCode(challenge, wrongCode(key), {
			oauth_query: authorized.oauthQuery,
		});
		expect(wrong.status).toBe(401);
		expect(await wrong.clone().text()).not.toContain(app.redirectUri);

		const right = await enterCode(challenge, totp(key), { oauth_query: authorized.oauthQuery });
		expect(right.status).toBe(200);
		const { url } = (await right.clone().json()) as { url: string };
		expect(url.startsWith(app.redirectUri)).toBe(true);

		const claims = await exchange(app, authorized, new URL(url));
		expect(claims.email).toBe(person.email);
		expect(claims.sub).not.toBe(person.userId);
	});

	it("carries on with a recovery code too", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { recoveryCodes } = await enrol(person);
		const authorized = await authorize(app);
		const { challenge } = await givePassword(person, { oauth_query: authorized.oauthQuery });
		const used = await enterRecoveryCode(challenge, recoveryCodes[0] ?? "", {
			oauth_query: authorized.oauthQuery,
		});
		const { url } = (await used.clone().json()) as { url: string };
		expect((await exchange(app, authorized, new URL(url))).email).toBe(person.email);
	});

	it("still refuses someone the check refuses, after a right code", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { key } = await enrol(person);
		const authorized = await authorize(app);
		const { challenge } = await givePassword(person, { oauth_query: authorized.oauthQuery });
		await id.db
			.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
			.bind(person.userId)
			.run();

		const entered = await enterCode(challenge, totp(key), { oauth_query: authorized.oauthQuery });
		const { url } = (await entered.clone().json()) as { url: string };
		// The page's query names the app's address, so look at where it leads.
		const location = new URL(url, origin);
		expect(location.origin + location.pathname).toBe(`${origin}/no-access`);
		expect(location.searchParams.has("code")).toBe(false);
	});

	it("asks again when an app wants someone already signed in to sign in again", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { key } = await enrol(person);
		const authorized = await authorize(app, person.cookie, { prompt: "login" });
		expect(authorized.location.pathname).toBe("/login");
		const before = await authorizationCodes();

		const response = await api("/sign-in/email", {
			cookie: person.cookie,
			body: { email: person.email, password: PASSWORD, oauth_query: authorized.oauthQuery },
		});
		expect((await response.clone().json()) as object).toEqual({
			twoFactorRedirect: true,
			twoFactorMethods: ["totp"],
		});
		expect(await authorizationCodes()).toBe(before);

		const entered = await enterCode(cookieOf(response), totp(key), {
			oauth_query: authorized.oauthQuery,
		});
		const { url } = (await entered.clone().json()) as { url: string };
		expect((await exchange(app, authorized, new URL(url))).email).toBe(person.email);
	});
});

describe("apps someone is already signed in to", () => {
	it("are signed out when it is turned on, and again when it is turned off", async () => {
		const app = await newApp();
		const person = await newPerson();
		const signedIn = await authorize(app, person.cookie);
		await exchange(app, signedIn, signedIn.location);

		await enrol(person);
		await vi.waitFor(() => expect(logoutsTo(app).length).toBe(1), { timeout: 5_000 });

		const again = await authorize(app, person.cookie);
		await exchange(app, again, again.location);
		const off = await api("/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(off.status).toBe(200);
		await vi.waitFor(() => expect(logoutsTo(app).length).toBe(2), { timeout: 5_000 });
	});
});

describe("turning it off", () => {
	it("takes the password", async () => {
		const person = await newPerson();
		await enrol(person);
		const refused = await api("/two-factor/disable", {
			cookie: person.cookie,
			body: { password: "not-the-password" },
		});
		expect(refused.status).toBe(400);
		expect((await sessionOf(person.cookie))?.user.twoFactorEnabled).toBe(true);
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});

	it("takes a session, and a challenge is not one", async () => {
		const person = await newPerson();
		await enrol(person);
		const { challenge } = await givePassword(person);
		const refused = await api("/two-factor/disable", {
			cookie: challenge,
			body: { password: PASSWORD },
		});
		expect(refused.status).toBe(401);
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});

	it("leaves the password enough, and removes the key and the recovery codes", async () => {
		const person = await newPerson();
		await enrol(person);
		const off = await api("/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(off.status).toBe(200);
		person.cookie = cookieOf(off);

		expect(await twoFactorRow(person)).toBeNull();
		expect((await sessionOf(person.cookie))?.user.twoFactorEnabled).toBe(false);
		const { challenge, body } = await givePassword(person);
		expect(body.twoFactorRedirect).toBeUndefined();
		expect(await sessionOf(challenge)).not.toBeNull();
	});
});

describe("someone who has lost everything, helped by whoever runs the deployment", () => {
	it("signs in with a password alone afterwards, and the log says who turned it off", async () => {
		const person = await newPerson();
		const someoneElse = await newPerson();
		await enrol(person);
		await enrol(someoneElse);

		for (const statement of removeTwoFactorStatements(person.email)) {
			await id.db.prepare(statement).run();
		}

		expect(await twoFactorRow(person)).toBeNull();
		const { challenge, body } = await givePassword(person);
		expect(body.twoFactorRedirect).toBeUndefined();
		expect(await sessionOf(challenge)).not.toBeNull();
		expect(await id.auditEvents(person.userId)).toContainEqual(
			expect.objectContaining({ type: "two_factor_disabled", detail: "operator" }),
		);

		expect((await givePassword(someoneElse)).body.twoFactorRedirect).toBe(true);
		expect(await id.auditEvents(someoneElse.userId)).not.toContainEqual(
			expect.objectContaining({ type: "two_factor_disabled" }),
		);
	});

	it("writes nothing to the log about someone who did not have it on", async () => {
		const person = await newPerson();
		for (const statement of removeTwoFactorStatements(person.email)) {
			await id.db.prepare(statement).run();
		}
		expect(await id.auditEvents(person.userId)).not.toContainEqual(
			expect.objectContaining({ type: "two_factor_disabled" }),
		);
	});

	it("takes an address as nothing but an address", async () => {
		const person = await newPerson();
		await enrol(person);
		const attempt = `${person.email}' OR '1'='1`;
		for (const statement of removeTwoFactorStatements(attempt)) {
			await id.db.prepare(statement).run();
		}
		expect((await givePassword(person)).body.twoFactorRedirect).toBe(true);
	});

	it("can tell an address nobody has from someone with it on or off", async () => {
		const person = await newPerson();
		const state = (email: string) => id.db.prepare(twoFactorStateQuery(email)).first();
		expect(await state("nobody-here@example.com")).toBeNull();
		expect(await state(person.email)).toEqual({ two_factor_enabled: 0 });
		await enrol(person);
		expect(await state(person.email)).toEqual({ two_factor_enabled: 1 });
	});
});

describe("the audit log", () => {
	it("says when it was turned on and off, which is not someone signing in", async () => {
		const person = await newPerson();
		await enrol(person);
		await id.auditEventRecorded(person.userId, { type: "two_factor_enabled" });
		const off = await api("/two-factor/disable", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(off.status).toBe(200);
		await id.auditEventRecorded(person.userId, { type: "two_factor_disabled" });

		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "sign_in")).toEqual([
			expect.objectContaining({ detail: "code" }),
		]);
	});

	it("says a password was right and a code asked for, which is not someone signing in", async () => {
		const person = await newPerson();
		await enrol(person);
		await givePassword(person);
		await id.auditEventRecorded(person.userId, { type: "two_factor_asked", detail: "password" });

		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ detail }) => detail === "password")).toEqual([
			expect.objectContaining({ type: "two_factor_asked" }),
		]);
	});

	it("says a password alone signed in someone who has not turned it on", async () => {
		const person = await newPerson();
		await givePassword(person);
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "password" });
		const events = await id.auditEvents(person.userId);
		expect(events.map(({ type }) => type)).not.toContain("two_factor_asked");
	});

	it("says how someone got past the code, and when they did not", async () => {
		const person = await newPerson();
		const { key, recoveryCodes } = await enrol(person);

		const { challenge } = await givePassword(person);
		await enterCode(challenge, wrongCode(key));
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed", detail: "totp" });
		await enterCode(challenge, totp(key));
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "totp" });

		const second = await givePassword(person);
		await enterRecoveryCode(second.challenge, "not-a-recovery-code");
		await id.auditEventRecorded(person.userId, {
			type: "sign_in_failed",
			detail: "recovery_code",
		});
		await enterRecoveryCode(second.challenge, recoveryCodes[0] ?? "");
		await id.auditEventRecorded(person.userId, { type: "sign_in", detail: "recovery_code" });
	});

	it("records a code offered twice as a failure", async () => {
		const person = await newPerson();
		const { key } = await enrol(person);
		const code = totp(key);
		await enterCode((await givePassword(person)).challenge, code);
		await enterCode((await givePassword(person)).challenge, code);
		await id.auditEventRecorded(person.userId, { type: "sign_in_failed", detail: "totp" });
	});

	it("records nothing against anyone for a mistake made while turning it on", async () => {
		const person = await newPerson();
		const { key } = await askToEnrol(person);
		await enterCode(person.cookie, wrongCode(key));
		await enterCode(person.cookie, totp(key));
		await id.auditEventRecorded(person.userId, { type: "two_factor_enabled" });
		const events = await id.auditEvents(person.userId);
		expect(events.map(({ type }) => type)).not.toContain("sign_in_failed");
	});

	it("says when the recovery codes were replaced", async () => {
		const person = await newPerson();
		await enrol(person);
		await api("/two-factor/generate-backup-codes", {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		await id.auditEventRecorded(person.userId, { type: "recovery_codes_replaced" });
	});
});
