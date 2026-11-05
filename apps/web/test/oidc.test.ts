import { createHmac } from "node:crypto";
import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { PAIRWISE_SECRET, startId } from "./id-worker";

// The provider as an app meets it: a real OIDC client library (oauth4webapi) against the built
// Worker, through discovery and the JWKS, the way the products will sign people in. What the sign-in
// pages do with a person on the way is in e2e/.

const origin = "https://id.test";
const issuer = new URL(origin);
const APP_SERVER = "198.51.100.1";
const SCOPE = "openid profile email offline_access";

let id: Awaited<ReturnType<typeof startId>>;
let as: oauth.AuthorizationServer;

/** An app's server calling ID. Apps share an address, as apps on Workers do. */
const appFetch: typeof fetch = (input, init) =>
	id.fetch(input as string, {
		...init,
		headers: { ...Object.fromEntries(new Headers(init?.headers)), "cf-connecting-ip": APP_SERVER },
	});

const fromApp = { [oauth.customFetch]: appFetch };

async function discover(): Promise<oauth.AuthorizationServer> {
	const response = await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp });
	return oauth.processDiscoveryResponse(issuer, response);
}

beforeAll(async () => {
	id = await startId(origin);
	as = await discover();
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

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
	client: string;
	cookie: string;
	userId: string;
}

let people = 0;

/** Someone who has proved an address with a code, and done nothing else yet. */
async function newPersonWithOnlyACode(): Promise<Person> {
	const email = `person-${++people}@example.com`;
	const client = newClient();
	await api("/email-otp/send-verification-otp", { client, body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { client, body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	return { email, client, cookie: cookieOf(entered), userId: user.id };
}

function choosePassword(person: Person, body: object = {}) {
	return api("/account/first-password", {
		client: person.client,
		cookie: person.cookie,
		body: { newPassword: "a-long-password-for-tests", ...body },
	});
}

async function newPerson(): Promise<Person> {
	const person = await newPersonWithOnlyACode();
	expect((await choosePassword(person)).status).toBe(200);
	return person;
}

let apps = 0;

/** Registers an app the way scripts/add-app.ts does. `row` changes what lands in the database. */
async function newApp(row: Record<string, string | number | null> = {}) {
	const host = `app-${++apps}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const made = appRow({
		app: `app-${apps}`,
		name: `App ${apps}`,
		redirectUris: [redirectUri],
		backchannelLogoutUri: `https://${host}/logout`,
	});
	await id.db.prepare(insertStatement({ ...made.row, ...row } as typeof made.row)).run();
	return {
		appId: `app-${apps}`,
		name: `App ${apps}`,
		host,
		redirectUri,
		clientId: made.clientId,
		clientSecret: made.clientSecret,
		client: { client_id: made.clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(made.clientSecret),
	};
}

type App = Awaited<ReturnType<typeof newApp>>;

/** A browser arriving at the authorization endpoint, as an app would send it there. */
async function authorize(app: App, person: Person | null, params: Record<string, string> = {}) {
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
		headers: {
			"cf-connecting-ip": person?.client ?? newClient(),
			...(person && { cookie: person.cookie }),
		},
	});
	// Miniflare's fetch says `sec-fetch-mode: cors` whatever it is told, and the provider answers that
	// with where to go where a browser's navigation gets a redirect. e2e/ has the real thing.
	const { url: target } =
		response.status === 200 ? ((await response.clone().json()) as { url: string }) : { url: "" };
	const location = new URL(response.headers.get("location") ?? target ?? "/nowhere", origin);
	return { response, location, state, nonce, verifier };
}

type Authorized = Awaited<ReturnType<typeof authorize>>;

/** What an app's server does with the redirect: exchanges the code and checks all of what it gets. */
async function exchange(app: App, authorized: Authorized, client = as) {
	const params = oauth.validateAuthResponse(
		client,
		app.client,
		authorized.location,
		authorized.state,
	);
	const response = await oauth.authorizationCodeGrantRequest(
		client,
		app.client,
		app.auth,
		params,
		app.redirectUri,
		authorized.verifier,
		fromApp,
	);
	const tokens = await oauth.processAuthorizationCodeResponse(client, app.client, response, {
		expectedNonce: authorized.nonce,
		requireIdToken: true,
	});
	// Through the JWKS, though a client that got this over TLS may skip it, because the products
	// and Cloudflare Access can rely on it only if it holds.
	await oauth.validateApplicationLevelSignature(client, response, fromApp);
	const claims = oauth.getValidatedIdTokenClaims(tokens);
	if (!claims) throw new Error("No ID token");
	return { tokens, claims };
}

async function signInToApp(app: App, person: Person) {
	return exchange(app, await authorize(app, person));
}

async function refresh(app: App, refreshToken: string | undefined) {
	const response = await oauth.refreshTokenGrantRequest(
		as,
		app.client,
		app.auth,
		refreshToken ?? "",
		fromApp,
	);
	return oauth.processRefreshTokenResponse(as, app.client, response);
}

function setEmailVerified(person: Person, verified: boolean) {
	return id.db
		.prepare("UPDATE user SET email_verified = ? WHERE id = ?")
		.bind(verified ? 1 : 0, person.userId)
		.run();
}

function expectNoCode(authorized: Authorized, app: App) {
	expect(authorized.location.searchParams.has("code")).toBe(false);
	expect(authorized.location.host).not.toBe(app.host);
}

function expectRefused(authorized: Authorized, app: App) {
	expectNoCode(authorized, app);
	expect(authorized.location.pathname).toBe("/no-access");
}

/** Whether a compact JWT's signature holds against a key in the deployment's JWKS. */
async function signatureHolds(jwt: string): Promise<boolean> {
	const [header = "", payload = "", signature = ""] = jwt.split(".");
	const { kid } = JSON.parse(Buffer.from(header, "base64url").toString()) as { kid: string };
	const response = await appFetch(as.jwks_uri ?? "");
	const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid: string })[] };
	const jwk = keys.find((key) => key.kid === kid);
	if (!jwk) return false;
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		Buffer.from(signature, "base64url"),
		Buffer.from(`${header}.${payload}`),
	);
}

describe("discovery", () => {
	it("publishes the issuer at its root, and what a client needs", () => {
		expect(as.issuer).toBe(origin);
		expect(as.authorization_endpoint).toBe(`${origin}/api/auth/oauth2/authorize`);
		expect(as.token_endpoint).toBe(`${origin}/api/auth/oauth2/token`);
		expect(as.jwks_uri).toBe(`${origin}/api/auth/jwks`);
		expect(as.id_token_signing_alg_values_supported).toEqual(["ES256"]);
		expect(as.subject_types_supported).toContain("pairwise");
		expect(as.code_challenge_methods_supported).toEqual(["S256"]);
		expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
		expect(as.backchannel_logout_supported).toBe(true);
	});

	it("offers nobody a way to register an app", () => {
		expect(as.registration_endpoint).toBeUndefined();
	});

	it("takes the issuer from settings, whatever host a request names", async () => {
		const response = await id.fetch("https://elsewhere.test/.well-known/openid-configuration");
		const metadata = (await response.json()) as { issuer: string; token_endpoint: string };
		expect(metadata.issuer).toBe(origin);
		expect(metadata.token_endpoint).toBe(`${origin}/api/auth/oauth2/token`);
	});
});

describe("signing in to an app", () => {
	it("completes the authorization code flow with PKCE, and the ID token checks out", async () => {
		const app = await newApp();
		const person = await newPerson();
		const authorized = await authorize(app, person);
		expect(authorized.location.origin + authorized.location.pathname).toBe(app.redirectUri);

		const { tokens, claims } = await exchange(app, authorized);
		expect(claims.iss).toBe(origin);
		expect(claims.aud).toBe(app.clientId);
		expect(claims.email).toBe(person.email);
		expect(claims.email_verified).toBe(true);
		expect(claims.name).toBe("Ada");
		// Opaque, and each says what it is, should one turn up in a log.
		expect(tokens.access_token).toMatch(/^gwid_at_/);
		expect(tokens.refresh_token).toMatch(/^gwid_rt_/);
	});

	it("signs ID tokens with ES256", async () => {
		const { tokens } = await signInToApp(await newApp(), await newPerson());
		const [header = ""] = (tokens.id_token ?? "").split(".");
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "ES256" });
	});

	it("gives only what the scopes ask for", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens, claims } = await exchange(
			app,
			await authorize(app, person, { scope: "openid" }),
		);
		expect(claims.email).toBeUndefined();
		expect(claims.name).toBeUndefined();
		expect(tokens.refresh_token).toBeUndefined();
	});

	it("answers userinfo for the same subject", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens, claims } = await signInToApp(app, person);
		const response = await oauth.userInfoRequest(as, app.client, tokens.access_token, fromApp);
		const info = await oauth.processUserInfoResponse(as, app.client, claims.sub, response);
		expect(info.email).toBe(person.email);
	});

	it("sends someone who is not signed in to the sign-in page, with a signed way back", async () => {
		const authorized = await authorize(await newApp(), null);
		expect(authorized.location.pathname).toBe("/login");
		expect(authorized.location.searchParams.has("sig")).toBe(true);
	});

	it("tells the app when it asks not to show anything to someone who is not signed in", async () => {
		const app = await newApp();
		const authorized = await authorize(app, null, { prompt: "none" });
		expect(authorized.location.origin + authorized.location.pathname).toBe(app.redirectUri);
		expect(authorized.location.searchParams.get("error")).toBe("login_required");
	});
});

describe("subjects", () => {
	it("gives a person a different id in each app, and never their real one", async () => {
		const person = await newPerson();
		const first = await signInToApp(await newApp(), person);
		const second = await signInToApp(await newApp(), person);
		expect(first.claims.sub).not.toBe(second.claims.sub);
		expect(first.claims.sub).not.toBe(person.userId);
		expect(second.claims.sub).not.toBe(person.userId);
	});

	it("gives two people different ids in one app, and one person the same id every time", async () => {
		const app = await newApp();
		const person = await newPerson();
		const first = await signInToApp(app, person);
		const again = await signInToApp(app, person);
		const other = await signInToApp(app, await newPerson());
		expect(again.claims.sub).toBe(first.claims.sub);
		expect(other.claims.sub).not.toBe(first.claims.sub);
	});

	// Apps key their accounts on this. If an upgrade of Better Auth derived it differently, everybody
	// would turn into a new person in every app, with nothing to show for it but this test.
	it("derives the id as it always has", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { claims } = await signInToApp(app, person);
		const expected = createHmac("sha256", PAIRWISE_SECRET)
			.update(`${app.host}.${person.userId}`)
			.digest("base64");
		expect(claims.sub).toBe(expected);
	});
});

describe("who may sign in", () => {
	it.each([
		["has no app in its metadata", "{}"],
		["has no metadata", null],
		["has an empty app", '{"app":""}'],
		["has an app that is not a name", '{"app":5}'],
	])("refuses everybody an app that %s", async (_case, metadata) => {
		const app = await newApp({ metadata });
		expectRefused(await authorize(app, await newPerson()), app);
	});

	it("gives no code for an app whose metadata is not JSON", async () => {
		const app = await newApp({ metadata: "not json" });
		expectNoCode(await authorize(app, await newPerson()), app);
	});

	it("tells the app when a refused person arrives with nothing to be shown", async () => {
		const app = await newApp();
		const person = await newPerson();
		await setEmailVerified(person, false);
		const authorized = await authorize(app, person, { prompt: "none" });
		expect(authorized.location.origin + authorized.location.pathname).toBe(app.redirectUri);
		expect(authorized.location.searchParams.has("code")).toBe(false);
		expect(authorized.location.searchParams.get("error")).toBe("interaction_required");
	});

	it("refuses a person without a verified address", async () => {
		const app = await newApp();
		const person = await newPerson();
		await setEmailVerified(person, false);
		expectRefused(await authorize(app, person), app);
	});

	it("lets the same person in once the address is verified", async () => {
		const app = await newApp();
		const person = await newPerson();
		await setEmailVerified(person, false);
		expectRefused(await authorize(app, person), app);
		await setEmailVerified(person, true);
		const { claims } = await signInToApp(app, person);
		expect(claims.email).toBe(person.email);
	});

	it("refuses a code that was issued before the person was refused", async () => {
		const app = await newApp();
		const person = await newPerson();
		const authorized = await authorize(app, person);
		await setEmailVerified(person, false);
		await expect(exchange(app, authorized)).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("refuses a code when the app can no longer be named", async () => {
		const app = await newApp();
		const authorized = await authorize(app, await newPerson());
		await id.db
			.prepare("UPDATE oauth_client SET metadata = NULL WHERE client_id = ?")
			.bind(app.clientId)
			.run();
		await expect(exchange(app, authorized)).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("refuses to refresh for someone refused since they signed in", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens } = await signInToApp(app, person);
		await setEmailVerified(person, false);
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
	});

	it("does not let a refused person continue past the page that refused them", async () => {
		const app = await newApp();
		const person = await newPerson();
		await setEmailVerified(person, false);
		const refused = await authorize(app, person);
		expectRefused(refused, app);
		const oauthQuery = refused.location.search.slice(1);

		for (const [path, body] of [
			["/oauth2/continue", { postLogin: true }],
			["/oauth2/continue", { selected: true }],
			["/oauth2/continue", { created: true }],
			["/oauth2/consent", { accept: true }],
		] as const) {
			const response = await api(path, {
				client: person.client,
				cookie: person.cookie,
				body: { ...body, oauth_query: oauthQuery },
			});
			const text = await response.text();
			expect(text).not.toContain("code=");
			expect(text).not.toContain(app.redirectUri);
		}
	});
});

describe("someone who has only proved an address", () => {
	/** The signed query of the page someone was sent to, which a page sends back with every POST. */
	function signedQuery({ location }: Authorized): string {
		return location.search.slice(1);
	}

	async function carryOn(person: Person, authorized: Authorized) {
		const response = await api("/oauth2/continue", {
			client: person.client,
			cookie: person.cookie,
			body: { created: true, oauth_query: signedQuery(authorized) },
		});
		expect(response.status).toBe(200);
		const { url } = (await response.json()) as { url: string };
		return new URL(url, origin);
	}

	it("chooses a password before the app hears of them", async () => {
		const app = await newApp();
		const { location } = await authorize(app, await newPersonWithOnlyACode());
		expect(location.pathname).toBe("/welcome");
		expect(location.searchParams.has("code")).toBe(false);
	});

	it("is not sent there by an app that asked to show nothing", async () => {
		const app = await newApp();
		const { location } = await authorize(app, await newPersonWithOnlyACode(), { prompt: "none" });
		expect(location.host).toBe(app.host);
		expect(location.searchParams.get("error")).toBe("interaction_required");
		expect(location.searchParams.has("code")).toBe(false);
	});

	it("cannot just say they are done", async () => {
		const app = await newApp();
		const person = await newPersonWithOnlyACode();
		const next = await carryOn(person, await authorize(app, person));
		expect(next.pathname).toBe("/welcome");
		expect(next.searchParams.has("code")).toBe(false);
	});

	it("reaches the app once they have a password", async () => {
		const app = await newApp();
		const person = await newPersonWithOnlyACode();
		const authorized = await authorize(app, person);

		const chosen = await choosePassword(person, { oauth_query: signedQuery(authorized) });
		expect(chosen.status).toBe(200);

		const location = await carryOn(person, authorized);
		expect(location.host).toBe(app.host);
		const { claims } = await exchange(app, { ...authorized, location });
		expect(claims.email).toBe(person.email);
	});

	it("sets no password from a page that has run out", async () => {
		const app = await newApp();
		const person = await newPersonWithOnlyACode();
		const stale = new URLSearchParams(signedQuery(await authorize(app, person)));
		stale.set("exp", "1");

		const chosen = await choosePassword(person, { oauth_query: stale.toString() });
		expect(chosen.status).toBe(400);
		expect(await chosen.json()).toMatchObject({ error: "invalid_signature" });
		// Nothing happened, so the next page they get, once they start again, can still ask.
		expect((await authorize(app, person)).location.pathname).toBe("/welcome");
	});
});

describe("an app asking for an account to be made", () => {
	it("sends someone who is not signed in to the page that sends them to sign up", async () => {
		const app = await newApp();
		const { location } = await authorize(app, null, { prompt: "create" });
		expect(location.pathname).toBe("/welcome");
		expect(location.searchParams.get("prompt")).toBe("create");
	});

	it("lets someone with an account through once told they are done", async () => {
		const app = await newApp();
		const person = await newPerson();
		const authorized = await authorize(app, person, { prompt: "create" });
		expect(authorized.location.pathname).toBe("/welcome");

		const response = await api("/oauth2/continue", {
			client: person.client,
			cookie: person.cookie,
			body: { created: true, oauth_query: authorized.location.search.slice(1) },
		});
		const { url } = (await response.json()) as { url: string };
		const location = new URL(url, origin);
		expect(location.host).toBe(app.host);
		const { claims } = await exchange(app, { ...authorized, location });
		expect(claims.email).toBe(person.email);
	});
});

describe("what an app must get right", () => {
	it("insists on PKCE", async () => {
		const app = await newApp();
		const authorized = await authorize(app, await newPerson(), {
			code_challenge: "",
			code_challenge_method: "",
		});
		expect(authorized.location.searchParams.has("code")).toBe(false);
	});

	it("refuses the wrong verifier", async () => {
		const app = await newApp();
		const authorized = await authorize(app, await newPerson());
		await expect(
			exchange(app, { ...authorized, verifier: oauth.generateRandomCodeVerifier() }),
		).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("takes a code only once", async () => {
		const app = await newApp();
		const authorized = await authorize(app, await newPerson());
		await exchange(app, authorized);
		await expect(exchange(app, authorized)).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it.each([
		["another host", (uri: string) => uri.replace(".apps.test", ".elsewhere.test")],
		["a longer path", (uri: string) => `${uri}/more`],
		["a query added", (uri: string) => `${uri}?next=/`],
	])("never sends a code to %s", async (_case, change) => {
		const app = await newApp();
		const redirect = change(app.redirectUri);
		const authorized = await authorize(app, await newPerson(), { redirect_uri: redirect });
		expect(authorized.location.searchParams.has("code")).toBe(false);
		expect(authorized.location.href.startsWith(redirect)).toBe(false);
	});

	it("refuses a wrong secret, and the right one without its prefix", async () => {
		const app = await newApp();
		const person = await newPerson();
		for (const secret of ["gwid_cs_wrong", app.clientSecret.replace("gwid_cs_", "")]) {
			await expect(
				exchange({ ...app, auth: oauth.ClientSecretBasic(secret) }, await authorize(app, person)),
			).rejects.toMatchObject({ status: 401 });
		}
	});

	it("refuses a code issued to another app", async () => {
		const app = await newApp();
		const other = await newApp();
		const authorized = await authorize(app, await newPerson());
		await expect(
			exchange({ ...other, redirectUri: app.redirectUri }, authorized),
		).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("refuses a disabled app", async () => {
		const app = await newApp({ disabled: 1 });
		const authorized = await authorize(app, await newPerson());
		expect(authorized.location.searchParams.has("code")).toBe(false);
	});
});

describe("refresh tokens", () => {
	it("rotates them", async () => {
		const app = await newApp();
		const { tokens, claims } = await signInToApp(app, await newPerson());
		const refreshed = await refresh(app, tokens.refresh_token);
		expect(refreshed.refresh_token).toMatch(/^gwid_rt_/);
		expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
		expect(refreshed.access_token).not.toBe(tokens.access_token);
		expect(oauth.getValidatedIdTokenClaims(refreshed)?.sub).toBe(claims.sub);
	});

	it("takes a used one for a theft, and revokes the lot", async () => {
		const app = await newApp();
		const { tokens } = await signInToApp(app, await newPerson());
		const refreshed = await refresh(app, tokens.refresh_token);
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		await expect(refresh(app, refreshed.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
	});

	it("are for the app they were issued to", async () => {
		const { tokens } = await signInToApp(await newApp(), await newPerson());
		await expect(refresh(await newApp(), tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
	});
});

describe("the audit log", () => {
	it("records an app learning who someone is, and not each time it refreshes", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens } = await signInToApp(app, person);
		await id.auditEventRecorded(person.userId, { type: "app_sign_in", app: app.appId, ip: null });

		await refresh(app, tokens.refresh_token);
		// Something later, by the same path.
		setEmailVerified(person, false);
		await authorize(app, person);
		await id.auditEventRecorded(person.userId, { type: "refused", app: app.appId });
		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "app_sign_in").length).toBe(1);
	});

	it("records someone being refused on the way to an app", async () => {
		const app = await newApp();
		const person = await newPerson();
		await setEmailVerified(person, false);
		expectRefused(await authorize(app, person), app);
		await id.auditEventRecorded(person.userId, {
			type: "refused",
			app: app.appId,
			detail: "authorization",
			ip: person.client,
		});
		const events = await id.auditEvents(person.userId);
		expect(events.filter(({ type }) => type === "app_sign_in")).toEqual([]);
	});

	it("records someone refused when an app refreshes their tokens", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens } = await signInToApp(app, person);
		await setEmailVerified(person, false);
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		await id.auditEventRecorded(person.userId, {
			type: "refused",
			app: app.appId,
			detail: "refresh_token",
		});
	});

	it.each([
		[true, "consent_granted"],
		[false, "consent_denied"],
	])("records the answer to asking for consent: %s", async (accept, type) => {
		const app = await newApp({ skip_consent: 0 });
		const person = await newPerson();
		const asked = await authorize(app, person);
		expect(asked.location.pathname).toBe("/consent");
		const answered = await api("/oauth2/consent", {
			client: person.client,
			cookie: person.cookie,
			body: { accept, oauth_query: asked.location.search.slice(1) },
		});
		expect(answered.status).toBe(200);
		await id.auditEventRecorded(person.userId, { type, app: app.appId, ip: person.client });
	});

	it("records no revoking that was refused", async () => {
		const app = await newApp();
		const { tokens } = await signInToApp(app, await newPerson());
		const refused = await oauth.revocationRequest(
			as,
			app.client,
			oauth.ClientSecretBasic("not-its-secret"),
			tokens.refresh_token ?? "",
			fromApp,
		);
		expect(refused.status).toBeGreaterThanOrEqual(400);
		// Something later, from the same app.
		const accepted = await oauth.revocationRequest(
			as,
			app.client,
			app.auth,
			tokens.refresh_token ?? "",
			fromApp,
		);
		expect(accepted.status).toBe(200);

		const revoked = async () => {
			const { results } = await id.db
				.prepare("SELECT id FROM audit_event WHERE type = 'token_revoked' AND app = ?")
				.bind(app.appId)
				.all();
			return results.length;
		};
		await vi.waitFor(async () => expect(await revoked()).toBeGreaterThan(0), { timeout: 5_000 });
		expect(await revoked()).toBe(1);
	});

	it("records an app revoking a token, and keeps none of its secret", async () => {
		const app = await newApp();
		const { tokens } = await signInToApp(app, await newPerson());
		const response = await oauth.revocationRequest(
			as,
			app.client,
			app.auth,
			tokens.refresh_token ?? "",
			fromApp,
		);
		expect(response.status).toBe(200);
		const revoked = () =>
			id.db
				.prepare("SELECT * FROM audit_event WHERE type = 'token_revoked' AND app = ?")
				.bind(app.appId)
				.first<Record<string, unknown>>();
		await vi.waitFor(async () => expect(await revoked()).toMatchObject({ ip: APP_SERVER }), {
			timeout: 5_000,
		});
		const row = JSON.stringify(await revoked());
		expect(row).not.toContain(app.clientSecret);
		expect(row).not.toContain(tokens.refresh_token ?? "");
	});

	it("shows someone's activity whatever another client's metadata holds", async () => {
		await newApp({ metadata: "not json" });
		const app = await newApp();
		const person = await newPerson();
		await signInToApp(app, person);
		await id.auditEventRecorded(person.userId, { type: "app_sign_in" });
		const response = await api("/account/activity", person);
		expect(response.status).toBe(200);
	});

	it("names the app in someone's own activity, by its id once it has gone", async () => {
		const app = await newApp();
		const person = await newPerson();
		await signInToApp(app, person);
		await id.auditEventRecorded(person.userId, { type: "app_sign_in" });

		const namesShown = async () => {
			const response = await api("/account/activity", person);
			const { events } = (await response.json()) as {
				events: { type: string; app: string | null }[];
			};
			return events.find(({ type }) => type === "app_sign_in")?.app;
		};
		expect(await namesShown()).toBe(app.name);

		await id.db.prepare("DELETE FROM oauth_client WHERE client_id = ?").bind(app.clientId).run();
		expect(await namesShown()).toBe(app.appId);
	});
});

describe("what nobody gets", () => {
	it("hands out no JWT holding someone's real id", async () => {
		const person = await newPerson();
		const session = await api("/token", { client: person.client, cookie: person.cookie });
		expect(session.status).toBe(404);
	});

	// A JWT access token's subject is the real id, whatever the app's subject type, so asking for one
	// would undo pairwise subjects. The provider always accepts its own userinfo endpoint as a
	// resource, which is the case that matters. An app may name one at any of these steps.
	it.each([
		"https://api.elsewhere.test",
		origin,
		`${origin}/api/auth`,
		`${origin}/api/auth/oauth2/userinfo`,
	])("refuses every step that names %s as a resource", async (resource) => {
		const app = await newApp();
		const person = await newPerson();
		const toToken = { ...fromApp, additionalParameters: { resource } };

		const named = await authorize(app, person, { resource });
		expect(named.response.status).toBe(400);
		expect(named.location.searchParams.has("code")).toBe(false);

		const authorized = await authorize(app, person);
		const atExchange = await oauth.authorizationCodeGrantRequest(
			as,
			app.client,
			app.auth,
			oauth.validateAuthResponse(as, app.client, authorized.location, authorized.state),
			app.redirectUri,
			authorized.verifier,
			toToken,
		);
		expect(atExchange.status).toBe(400);
		expect(await atExchange.json()).toMatchObject({ error: "invalid_target" });

		const { tokens } = await signInToApp(app, person);
		const atRefresh = await oauth.refreshTokenGrantRequest(
			as,
			app.client,
			app.auth,
			tokens.refresh_token ?? "",
			toToken,
		);
		expect(atRefresh.status).toBe(400);
		expect(await atRefresh.json()).toMatchObject({ error: "invalid_target" });
	});

	it("has no introspection, which would tell an app the session behind a token", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { tokens } = await signInToApp(app, person);
		const response = await appFetch(`${origin}/api/auth/oauth2/introspect`, {
			method: "POST",
			headers: {
				authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token: tokens.access_token }),
		});
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain(person.userId);

		const discovery = await appFetch(`${origin}/.well-known/openid-configuration`);
		expect(discovery.status).toBe(200);
		const offered = Object.keys((await discovery.json()) as object);
		expect(offered).toContain("token_endpoint");
		expect(offered.filter((name) => name.startsWith("introspection"))).toEqual([]);
	});

	it("says it takes no claims parameter, which it does not", async () => {
		const discovery = await appFetch(`${origin}/.well-known/openid-configuration`);
		const metadata = (await discovery.json()) as { claims_parameter_supported?: boolean };
		expect(metadata.claims_parameter_supported).toBe(false);
	});

	// The provider's own say what it can do rather than what is open here. They are for its server's use
	// only, which is all that keeps them from being read, so a new version that changed that would show.
	it.each(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"])(
		"has no second discovery document at %s",
		async (path) => {
			expect((await appFetch(`${origin}/api/auth${path}`)).status).toBe(404);
		},
	);

	it.each([
		"/token",
		"/oauth2/introspect",
		"/oauth2/public-client",
		"/.well-known/openid-configuration",
	])("keeps %s closed however it is written", async (path) => {
		const encoded = `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`;
		const spellings = [
			`/api/auth${path}/`,
			`/api/auth/${path}`,
			`/api/auth${encoded}`,
			`/api/auth${path.toUpperCase()}`,
		];
		for (const spelling of spellings) {
			for (const method of ["GET", "POST"]) {
				const answer = await appFetch(`${origin}${spelling}`, {
					method,
					redirect: "manual",
					headers: { origin, "content-type": "application/x-www-form-urlencoded" },
					...(method === "POST" && { body: "token=nothing" }),
				});
				expect([spelling, method, answer.status]).toEqual([spelling, method, 404]);
			}
		}
	});

	// The framework tidies addresses, and `//somewhere.else/` tidied badly would be a link away from here.
	it.each([
		"//evil.example/",
		"///evil.example/",
		"/\\evil.example/",
		"/.//evil.example/",
		"/%2F%2Fevil.example/",
	])("sends nobody away for writing an address as %s", async (path) => {
		const answer = await appFetch(`${origin}${path}`, { redirect: "manual" });
		const where = answer.headers.get("location");
		expect(where).not.toBeNull();
		expect(new URL(where ?? "", origin).origin).toBe(origin);
	});

	it("lets no signed-in person make, read or change an app", async () => {
		const app = await newApp();
		const person = await newPerson();
		const before = await id.db.prepare("SELECT * FROM oauth_client ORDER BY id").all();

		for (const [path, body] of [
			["/oauth2/create-client", { redirect_uris: ["https://evil.apps.test/cb"] }],
			["/admin/oauth2/create-client", { redirect_uris: ["https://evil.apps.test/cb"] }],
			["/oauth2/register", { redirect_uris: ["https://evil.apps.test/cb"] }],
			["/oauth2/update-client", { client_id: app.clientId, update: { name: "Mine now" } }],
			["/oauth2/client/rotate-secret", { client_id: app.clientId }],
			["/oauth2/delete-client", { client_id: app.clientId }],
		] as const) {
			const response = await api(path, { client: person.client, cookie: person.cookie, body });
			expect(response.status, path).toBeGreaterThanOrEqual(400);
		}
		for (const path of [`/oauth2/get-client?client_id=${app.clientId}`, "/oauth2/get-clients"]) {
			const response = await api(path, { client: person.client, cookie: person.cookie });
			expect(response.status, path).toBeGreaterThanOrEqual(400);
		}

		const after = await id.db.prepare("SELECT * FROM oauth_client ORDER BY id").all();
		expect(after.results).toEqual(before.results);
	});

	it("keeps an app's secret out of what the sign-in pages may read", async () => {
		const app = await newApp();
		const person = await newPerson();
		const row = await id.db
			.prepare("SELECT client_secret FROM oauth_client WHERE client_id = ?")
			.bind(app.clientId)
			.first<{ client_secret: string }>();
		expect(row?.client_secret).toBeTruthy();
		const page = await id.fetch(`${origin}/consent?client_id=${app.clientId}&scope=openid`, {
			headers: { "cf-connecting-ip": person.client, cookie: person.cookie, accept: "text/html" },
		});
		expect(page.status).toBe(200);
		const html = await page.text();
		// The page itself, which is given what it needs of the app and has to say so.
		expect(html).toContain(`Allow ${app.name} to use your account?`);
		expect(html).toContain(app.host);
		expect(html).not.toContain("client_secret");
		expect(html).not.toContain("clientSecret");
		expect(html).not.toContain(app.clientSecret);
		expect(html).not.toContain(row?.client_secret);
	});
});

describe("what the database holds", () => {
	it("keeps hashes of secrets and tokens, and no signing key in the clear", async () => {
		const app = await newApp();
		const { tokens } = await signInToApp(app, await newPerson());

		const row = await id.db
			.prepare("SELECT client_secret FROM oauth_client WHERE client_id = ?")
			.bind(app.clientId)
			.first<{ client_secret: string }>();
		expect(app.clientSecret).not.toContain(row?.client_secret);

		const stored = await id.db
			.prepare(
				`SELECT token FROM oauth_access_token WHERE client_id = ?1
				 UNION ALL SELECT token FROM oauth_refresh_token WHERE client_id = ?1`,
			)
			.bind(app.clientId)
			.all<{ token: string }>();
		expect(stored.results).toHaveLength(2);
		for (const { token } of stored.results) {
			expect(tokens.access_token).not.toContain(token);
			expect(tokens.refresh_token).not.toContain(token);
		}

		const keys = await id.db.prepare("SELECT private_key FROM jwks").all<{ private_key: string }>();
		expect(keys.results.length).toBeGreaterThan(0);
		for (const key of keys.results) expect(key.private_key).not.toContain('"d"');
	});
});

describe("signing out", () => {
	it("tells an app in a signed logout token", async () => {
		const app = await newApp();
		const person = await newPerson();
		const { claims } = await signInToApp(app, person);

		const out = await api("/sign-out", { client: person.client, cookie: person.cookie, body: {} });
		expect(out.status).toBe(200);

		const logoutUri = `https://${app.host}/logout`;
		let delivered: { url: string; body: string } | undefined;
		for (let attempt = 0; attempt < 100 && !delivered; attempt++) {
			delivered = id.outboundBodies.find((request) => request.url === logoutUri);
			if (!delivered) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const token = new URLSearchParams(delivered?.body).get("logout_token") ?? "";
		expect(await signatureHolds(token)).toBe(true);
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
		expect(payload).toMatchObject({ iss: origin, aud: app.clientId, sub: claims.sub });
		expect(Object.keys(payload.events)).toEqual([
			"http://schemas.openid.net/event/backchannel-logout",
		]);
	});

	describe("to an app that does not take it the first time", () => {
		/** Signs someone out of an app whose logout address answers these in turn. */
		async function signOutWith(answers: (number | "no answer")[]) {
			const app = await newApp();
			const logoutUri = `https://${app.host}/logout`;
			id.logoutAnswers.set(logoutUri, answers);
			const person = await newPerson();
			await signInToApp(app, person);
			const out = await api("/sign-out", {
				client: person.client,
				cookie: person.cookie,
				body: {},
			});
			expect(out.status).toBe(200);
			return () => id.outboundBodies.filter((request) => request.url === logoutUri);
		}

		it("tries again when the app has a problem, with the same token", async () => {
			const deliveries = await signOutWith([503]);
			await expect.poll(() => deliveries().length, { timeout: 10_000 }).toBe(2);
			expect(deliveries()[1]?.body).toBe(deliveries()[0]?.body);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			expect(deliveries()).toHaveLength(2);
		});

		it("tries again when the app does not answer in time", async () => {
			const deliveries = await signOutWith(["no answer"]);
			await expect.poll(() => deliveries().length, { timeout: 15_000 }).toBe(2);
		}, 20_000);

		it("gives up after three tries", async () => {
			const deliveries = await signOutWith([503, 503, 503]);
			await expect.poll(() => deliveries().length, { timeout: 15_000 }).toBe(3);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			expect(deliveries()).toHaveLength(3);
		}, 25_000);

		it("does not try again when the app refuses it, which would only repeat", async () => {
			const deliveries = await signOutWith([400]);
			await expect.poll(() => deliveries().length, { timeout: 10_000 }).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			expect(deliveries()).toHaveLength(1);
		});
	});
});

describe("signing keys", () => {
	it("gives a key 90 days, then rotates it, and publishes the old one for 30 more", async () => {
		const DAY = 86_400_000;
		const app = await newApp();
		const person = await newPerson();
		const before = await signInToApp(app, person);
		const kidOf = (jwt: string | undefined) =>
			(
				JSON.parse(Buffer.from((jwt ?? "").split(".")[0] ?? "", "base64url").toString()) as {
					kid: string;
				}
			).kid;
		const oldKid = kidOf(before.tokens.id_token);

		const key = await id.db
			.prepare("SELECT created_at, expires_at FROM jwks WHERE id = ?")
			.bind(oldKid)
			.first<{ created_at: number; expires_at: number }>();
		expect(Math.round(((key?.expires_at ?? 0) - (key?.created_at ?? 0)) / DAY)).toBe(90);

		const expireOldKey = (at: number) =>
			id.db.prepare("UPDATE jwks SET expires_at = ? WHERE id = ?").bind(at, oldKid).run();

		await expireOldKey(Date.now() - 1000);
		// A new client, because oauth4webapi keeps a JWKS for a minute even when a key is missing from
		// it. An app that had just fetched it fails one sign-in, a trade described in the architecture.
		const after = await exchange(app, await authorize(app, person), await discover());
		expect(kidOf(after.tokens.id_token)).not.toBe(oldKid);
		// A token signed just before has to keep checking out for as long as it lives.
		expect(await signatureHolds(before.tokens.id_token ?? "")).toBe(true);
		expect(await signatureHolds(after.tokens.id_token ?? "")).toBe(true);

		await expireOldKey(Date.now() - 31 * DAY);
		expect(await signatureHolds(before.tokens.id_token ?? "")).toBe(false);
		expect(await signatureHolds(after.tokens.id_token ?? "")).toBe(true);
	});
});

describe("rate limits", () => {
	it("does not stop apps' servers, which all come from one address", async () => {
		const app = await newApp();
		for (let request = 0; request < 25; request++) {
			const response = await oauth.refreshTokenGrantRequest(
				as,
				app.client,
				app.auth,
				"gwid_rt_not-a-token",
				fromApp,
			);
			expect(response.status).not.toBe(429);
		}
	});

	it("still stops a browser hammering the authorization endpoint", async () => {
		const app = await newApp();
		const person = await newPerson();
		let stopped = false;
		for (let request = 0; request < 35 && !stopped; request++) {
			const { response } = await authorize(app, person);
			stopped = response.status === 429;
		}
		expect(stopped).toBe(true);
	});
});

describe("a deployment without the secret", () => {
	it("is no provider at all", async () => {
		const plain = await startId(origin, { oidc: false });
		try {
			for (const path of [
				"/.well-known/openid-configuration",
				"/api/auth/.well-known/openid-configuration",
				"/api/auth/jwks",
				"/api/auth/oauth2/authorize?client_id=x",
			]) {
				const response = await plain.fetch(`${origin}${path}`);
				expect(response.status, path).toBe(404);
			}
		} finally {
			await plain.dispose();
		}
	});
});
