import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { startId } from "./id-worker";

// A query of D1 that failed for good, in the Worker as it deploys. Drizzle's error for it is
// `Failed query: select … params: …`, with every value the statement was given. A page whose read
// failed showed it and had it in its HTML, Better Auth logged the one for a session read, with the
// session's token among the values, and what answers without a page (the provider's endpoints, the
// daily run) let it into the log. Here the values are also an app's id, the hash of a code or of a
// refresh token and a person's address, and what answers is what every app signs people in
// through: it must answer an error, never a token and never a way on to the app.
// A table that is gone makes every read of it fail, as the database being down would.

const origin = "https://id.test";
const issuer = new URL(origin);
const PASSWORD = "a-long-password-for-tests";
const SCOPE = "openid profile email offline_access";
const APP_SERVER = "198.51.100.1";

let id: Awaited<ReturnType<typeof startId>>;
let as: oauth.AuthorizationServer;

/** An app's server calling ID. */
const appFetch: typeof fetch = (input, init) =>
	id.fetch(input as string, {
		...init,
		headers: { ...Object.fromEntries(new Headers(init?.headers)), "cf-connecting-ip": APP_SERVER },
	});

const fromApp = { [oauth.customFetch]: appFetch };

beforeAll(async () => {
	id = await startId(origin);
	const response = await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp });
	as = await oauth.processDiscoveryResponse(issuer, response);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;
/** A client address of its own for each request, so no limit on one address gets in the way. */
const newClient = () => `203.0.113.${++clients}`;

interface Who {
	cookie: string;
}

function api(path: string, init: { who?: Who; body?: object } = {}) {
	const { who, body } = init;
	return id.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			...(body && { "content-type": "application/json" }),
			...(who && { cookie: who.cookie }),
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
	return vi.waitFor(
		async () => {
			const sent = (await id.emails()).find((message) => message.to === email);
			const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
			if (!code) throw new Error(`No code reached ${email}`);
			return code;
		},
		{ timeout: 5_000 },
	);
}

let people = 0;

async function newPerson() {
	const email = `failed-query-${++people}@example.com`;
	await api("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	const who = { email, cookie: cookieOf(entered), userId: user.id };
	const chosen = await api("/account/first-password", { who, body: { newPassword: PASSWORD } });
	expect(chosen.status).toBe(200);
	return who;
}

type Person = Awaited<ReturnType<typeof newPerson>>;

let apps = 0;

/** An app everyone here can use, registered the way scripts/add-app.ts does. */
async function firstPartyApp() {
	const host = `failed-${++apps}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const made = appRow({
		app: `failed-${apps}`,
		name: `Failed ${apps}`,
		redirectUris: [redirectUri],
	});
	await id.db.prepare(insertStatement(made.row)).run();
	return {
		host,
		redirectUri,
		clientId: made.clientId,
		clientSecret: made.clientSecret,
		client: { client_id: made.clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(made.clientSecret),
	};
}

type App = Awaited<ReturnType<typeof firstPartyApp>>;

/** An app a workspace added, which asks its members before it tells the app anything. */
async function workspaceApp(owner: Person): Promise<App> {
	const slug = `failed-workspace-${++apps}`;
	const created = await api("/organization/create", { who: owner, body: { name: "Acme", slug } });
	expect(created.status).toBe(200);
	const { id: organizationId } = (await created.json()) as { id: string };
	const host = `failed-${apps}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const added = await api("/workspaces/apps/add", {
		who: owner,
		body: { organizationId, name: `Tool ${apps}`, redirectUris: [redirectUri] },
	});
	expect(added.status).toBe(200);
	const { clientId, clientSecret } = (await added.json()) as {
		clientId: string;
		clientSecret: string;
	};
	return {
		host,
		redirectUri,
		clientId,
		clientSecret,
		client: { client_id: clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(clientSecret),
	};
}

/** What became of a request, in every place a statement or a value could travel by. */
async function answerOf(response: Response) {
	const text = await response.text();
	const location = response.headers.get("location");
	return {
		status: response.status,
		text,
		location,
		/** Everything a client could read: the body, where it is sent and what it is told to keep. */
		everything: [text, location ?? "", ...response.headers.getSetCookie()].join("\n"),
	};
}

type Answer = Awaited<ReturnType<typeof answerOf>>;

/** A browser arriving at the authorization endpoint, as an app would send it there. */
async function authorizeRequest(app: App, person: Who | null, params: Record<string, string> = {}) {
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
	/** `from` is what the browser says of where it was sent from, if a test has it say so. */
	const send = (from: Record<string, string> = {}) =>
		id.fetch(url, {
			headers: {
				"cf-connecting-ip": newClient(),
				...(person && { cookie: person.cookie }),
				...from,
			},
		});
	return { send, state, nonce, verifier };
}

/** Miniflare's fetch is not a navigation, so a request can be told where to go rather than sent. */
function whereSent(answer: Answer) {
	let told: string | undefined;
	try {
		told = (JSON.parse(answer.text) as { url?: string }).url;
	} catch {}
	return new URL(answer.location ?? told ?? "/nowhere", origin);
}

/** Someone on their way back to the app with a code, which the app has not used yet. */
async function withACode(app: App, person: Person) {
	const asked = await authorizeRequest(app, person);
	let location = whereSent(await answerOf(await asked.send()));
	if (location.pathname === "/consent") {
		const agreed = await api("/oauth2/consent", {
			who: person,
			body: { accept: true, oauth_query: location.search.slice(1) },
		});
		expect(agreed.status).toBe(200);
		location = new URL(((await agreed.json()) as { url: string }).url);
	}
	expect(location.host).toBe(app.host);
	expect(location.searchParams.get("code")).toBeTruthy();
	return { ...asked, location };
}

type Returning = Awaited<ReturnType<typeof withACode>>;

/** The app's server asking for tokens with the code, as its library sends it. */
function tokenRequest(app: App, returning: Returning) {
	const params = oauth.validateAuthResponse(as, app.client, returning.location, returning.state);
	return oauth.authorizationCodeGrantRequest(
		as,
		app.client,
		app.auth,
		params,
		app.redirectUri,
		returning.verifier,
		fromApp,
	);
}

/** The tokens, as the app's library takes them after checking all of them. */
async function tokensFrom(app: App, returning: Returning, response: Response) {
	return oauth.processAuthorizationCodeResponse(as, app.client, response, {
		expectedNonce: returning.nonce,
		requireIdToken: true,
	});
}

function refreshRequest(app: App, refreshToken: string) {
	return oauth.refreshTokenGrantRequest(as, app.client, app.auth, refreshToken, fromApp);
}

/** Runs `work` with a table out of reach, and puts it back. */
async function without<Result>(table: string, work: () => Promise<Result>): Promise<Result> {
	await id.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
	try {
		return await work();
	} finally {
		await id.db.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
	}
}

/** What the Worker logged since `from`, as one text. */
const loggedSince = (from: number) =>
	id.logs
		.slice(from)
		.map((log) => log.message)
		.join("\n");

/** What the Worker logged about failed queries since `from`: a kind and a reference each. */
function failuresSince(from: number) {
	return id.logs.slice(from).flatMap((log) => {
		const found = /d1: a query failed \((.+?)\), reference ([0-9a-f]{8})/.exec(log.message);
		return found ? [{ kind: found[1], reference: found[2] }] : [];
	});
}

/** The reference the error notice shows. */
const shownIn = (html: string) => /<code>([0-9a-f]{8})<\/code>/.exec(html)?.[1];

/** Nothing of a statement, wherever a client or whoever reads the log could look. */
function expectNoStatement(text: string) {
	expect(text).not.toContain("Failed query");
	expect(text).not.toContain("params:");
	expect(text).not.toMatch(/\bselect\b[^<]*\bfrom\b/i);
	expect(text).not.toMatch(/\b(delete from|insert into|update) "/i);
}

/** No token of any kind, and no code. */
function expectNoTokens(answer: Answer) {
	expect(answer.everything).not.toMatch(/gwid_(at|rt)_/);
	expect(answer.everything).not.toMatch(/access_token|id_token|refresh_token/);
	expect(answer.everything).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./);
	expect(whereSent(answer).searchParams.has("code")).toBe(false);
}

// Server functions, called as the browser does once the page is up.
const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
function serverFnUrl(name: string) {
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const found = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!found) throw new Error(`No server function ${name} in the build`);
	return `${origin}/_serverFn/${found}`;
}

/**
 * Calls a GET server function with nothing, and answers what came back. `from` is what the browser
 * says of where the request was made: its own page, unless a test says another.
 */
async function serverFn(name: string, cookie: string, from: Record<string, string> = { origin }) {
	// Seroval's JSON for `{ data: undefined }`.
	const payload = JSON.stringify({
		t: { t: 10, i: 0, p: { k: ["data"], v: [{ t: 2, s: 1 }] }, o: 0 },
		f: 0,
		m: [],
	});
	const response = await id.fetch(`${serverFnUrl(name)}?payload=${encodeURIComponent(payload)}`, {
		headers: {
			"x-tsr-serverFn": "true",
			accept: "application/json",
			...from,
			cookie,
			"cf-connecting-ip": newClient(),
		},
	});
	return { status: response.status, text: await response.text() };
}

function page(path: string, who: Who) {
	return id.fetch(`${origin}${path}`, {
		headers: { cookie: who.cookie, "cf-connecting-ip": newClient() },
	});
}

describe("a page whose read of the database failed", () => {
	it("shows no statement and no values, and a reference that is in the log", async () => {
		const person = await newPerson();
		expect((await page("/account", person)).status).toBe(200);

		const from = id.logs.length;
		// The page asks which sign-ins the account has, by the person's id.
		const html = await without("account", async () => {
			const response = await page("/account", person);
			expect(response.status).toBe(500);
			return response.text();
		});

		expectNoStatement(html);
		expect(html).not.toContain("provider_id");
		expect(html).toContain("This page could not be loaded.");
		const failures = failuresSince(from);
		expect(failures.length).toBeGreaterThan(0);
		for (const { kind } of failures) {
			expect(kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: account");
		}
		expect(shownIn(html)).toBeDefined();
		expect(failures.map(({ reference }) => reference)).toContain(shownIn(html));
		expectNoStatementValues(loggedSince(from), person);
	});
});

/** The log may hold a statement, with `?` for its values. Never Drizzle's error, or who it was for. */
function expectNoStatementValues(logged: string, person: Person) {
	expect(logged).not.toContain("Failed query");
	expect(logged).not.toContain("params:");
	expect(logged).not.toContain(person.userId);
	expect(logged).not.toContain(person.email);
}

describe("a session read that failed", () => {
	it("puts no token in the log or the page", async () => {
		const person = await newPerson();
		const signed = /session_token=([^;]+)/.exec(person.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const from = id.logs.length;
		const html = await without("session", async () => {
			const response = await page("/account", person);
			expect(response.status).toBe(500);
			return response.text();
		});

		const logged = loggedSince(from);
		// Better Auth logs the failure it caught.
		expect(logged).toContain("[Better Auth]");
		expect(logged).not.toContain(token);
		expectNoStatementValues(logged, person);
		expect(html).not.toContain(token);
		expectNoStatement(html);
		expect(html).toContain("This page could not be loaded.");
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: session",
		);
		// The log has the statement that failed, with a `?` where the token was.
		expect(logged).toMatch(/"session"\."token" = \?/);

		// Better Auth throws its own error for this, with the database's as the cause. The page
		// shows that one's reference.
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(shownIn(html)).toBeDefined();
		expect(references).toContain(shownIn(html));
	});

	it("keeps its reference on the way out of a server function, where it is in the error's cause", async () => {
		const person = await newPerson();

		const from = id.logs.length;
		const answer = await without("session", () => serverFn("getSession", person.cookie));

		expect(answer.text).toContain("$TSR/Error");
		expectNoStatement(answer.text);
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(references).toHaveLength(1);
		expect(answer.text).toContain(`Failed to get session (reference ${references[0]})`);
	});
});

// What an app meets. None of these catches a failed query, so the answer is Better Auth's for an
// error it does not know: a 500 with nothing in it. An app's library takes that for a failure, and
// the person's browser is left here and not sent on.
describe("the provider's endpoints, when the database fails", () => {
	it("authorize sends nobody on to the app when the app cannot be read", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const asked = await authorizeRequest(app, person);

		const from = id.logs.length;
		const answer = await without("oauth_client", async () => answerOf(await asked.send()));

		expect(answer.status).toBe(500);
		expect(whereSent(answer).host).not.toBe(app.host);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		expect(answer.everything).not.toContain("error_description");
		const logged = loggedSince(from);
		expectNoStatementValues(logged, person);
		expect(logged).not.toContain(app.clientId);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: oauth_client",
		);

		// With the table back, the same request goes through.
		expect(whereSent(await answerOf(await asked.send())).searchParams.get("code")).toBeTruthy();
	});

	// The provider reads the session itself and takes a failure for nobody being signed in, so the
	// person is asked to sign in, here, and no app hears of them.
	it("authorize gives no code when the session cannot be read, and asks the person to sign in", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const asked = await authorizeRequest(app, person);

		const from = id.logs.length;
		const answer = await without("session", async () => answerOf(await asked.send()));

		expect(whereSent(answer).origin).toBe(origin);
		expect(whereSent(answer).pathname).toBe("/login");
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		expectNoStatementValues(loggedSince(from), person);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: session",
		);
	});

	it("authorize gives no code when whether the person may use the app cannot be read", async () => {
		const owner = await newPerson();
		const app = await workspaceApp(owner);
		// Once through, so that they have agreed and only the check stands between them and a code.
		await withACode(app, owner);
		const asked = await authorizeRequest(app, owner);

		const from = id.logs.length;
		// `maySignIn` asks whether they are a member.
		const answer = await without("member", async () => answerOf(await asked.send()));

		expect(answer.status).toBe(500);
		expect(whereSent(answer).host).not.toBe(app.host);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		expectNoStatementValues(loggedSince(from), owner);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: member",
		);
	});

	it("token gives none when the code cannot be looked up, and the code is still good once", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const returning = await withACode(app, person);
		const code = returning.location.searchParams.get("code") ?? "";

		const from = id.logs.length;
		const answer = await without("verification", async () =>
			answerOf(await tokenRequest(app, returning)),
		);

		expect(answer.status).toBe(500);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		const logged = loggedSince(from);
		expectNoStatementValues(logged, person);
		expect(logged).not.toContain(code);
		expect(logged).not.toContain(app.clientId);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: verification",
		);
		// The delete that uses a code up is never sent again by itself.
		expect(logged).not.toMatch(/a read failed .* and is sent again/);

		// It was never used, so it buys tokens now, and then never again.
		const tokens = await tokensFrom(app, returning, await tokenRequest(app, returning));
		expect(tokens.access_token).toMatch(/^gwid_at_/);
		const again = await answerOf(await tokenRequest(app, returning));
		expect(again.status).toBe(400);
		expect(JSON.parse(again.text)).toMatchObject({ error: "invalid_grant" });
	});

	it("token gives none when the tokens cannot be written, and the code it used is spent", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const returning = await withACode(app, person);

		const from = id.logs.length;
		const answer = await without("oauth_access_token", async () =>
			answerOf(await tokenRequest(app, returning)),
		);

		expect(answer.status).toBe(500);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		expectNoStatementValues(loggedSince(from), person);
		expect(failuresSince(from).length).toBeGreaterThan(0);

		// The code was used before the failure. It is not good a second time.
		const again = await answerOf(await tokenRequest(app, returning));
		expect(again.status).toBe(400);
		expect(JSON.parse(again.text)).toMatchObject({ error: "invalid_grant" });
		expectNoTokens(again);
	});

	it("token gives none when whether the person may still use the app cannot be read", async () => {
		const owner = await newPerson();
		const app = await workspaceApp(owner);
		const returning = await withACode(app, owner);

		const from = id.logs.length;
		// `customTokenResponseFields` asks again who may sign in, as the code is exchanged.
		const answer = await without("member", async () =>
			answerOf(await tokenRequest(app, returning)),
		);

		expect(answer.status).toBe(500);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		expectNoStatementValues(loggedSince(from), owner);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: member",
		);
	});

	it("a refresh gives no tokens when the token cannot be looked up, and it is still good once", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const returning = await withACode(app, person);
		const tokens = await tokensFrom(app, returning, await tokenRequest(app, returning));
		const refreshToken = tokens.refresh_token ?? "";
		expect(refreshToken).toMatch(/^gwid_rt_/);

		const from = id.logs.length;
		const answer = await without("oauth_refresh_token", async () =>
			answerOf(await refreshRequest(app, refreshToken)),
		);

		expect(answer.status).toBe(500);
		expectNoTokens(answer);
		expectNoStatement(answer.everything);
		const logged = loggedSince(from);
		expectNoStatementValues(logged, person);
		expect(logged).not.toContain(refreshToken);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: oauth_refresh_token",
		);

		// Not rotated, so it is good now, once.
		const refreshed = await oauth.processRefreshTokenResponse(
			as,
			app.client,
			await refreshRequest(app, refreshToken),
		);
		expect(refreshed.refresh_token).toMatch(/^gwid_rt_/);
		const again = await answerOf(await refreshRequest(app, refreshToken));
		expect(again.status).toBe(400);
		expect(JSON.parse(again.text)).toMatchObject({ error: "invalid_grant" });
	});

	it("userinfo tells nothing of anyone when the token cannot be looked up", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const returning = await withACode(app, person);
		const tokens = await tokensFrom(app, returning, await tokenRequest(app, returning));
		const ask = () =>
			appFetch(as.userinfo_endpoint ?? "", {
				headers: { authorization: `Bearer ${tokens.access_token}` },
			});
		expect(await (await ask()).json()).toMatchObject({ email: person.email });

		const from = id.logs.length;
		const answer = await without("oauth_access_token", async () => answerOf(await ask()));

		expect(answer.status).toBe(500);
		expect(answer.everything).not.toContain(person.email);
		expect(answer.everything).not.toContain('"sub"');
		expectNoStatement(answer.everything);
		const logged = loggedSince(from);
		expectNoStatementValues(logged, person);
		expect(logged).not.toContain(tokens.access_token);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: oauth_access_token",
		);
	});

	it("the keys and discovery answer an error and no half of either when the keys cannot be read", async () => {
		const from = id.logs.length;
		const [keys, discovery] = await without("jwks", async () => [
			await answerOf(await appFetch(as.jwks_uri ?? "")),
			await answerOf(await appFetch(`${origin}/.well-known/openid-configuration`)),
		]);

		for (const answer of [keys, discovery]) {
			expect(answer?.status).toBe(500);
			expect(answer?.everything).not.toContain('"keys"');
			expect(answer?.everything).not.toContain("authorization_endpoint");
			expectNoStatement(answer?.everything ?? "");
		}
		expect(loggedSince(from)).not.toContain("Failed query");
		for (const { kind } of failuresSince(from)) {
			expect(kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: jwks");
		}
		expect(failuresSince(from).length).toBeGreaterThanOrEqual(2);

		// With the table back, an app reads both as it did.
		const read = await appFetch(as.jwks_uri ?? "");
		expect(((await read.json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
	});
});

// What answers without a page or an app.
describe("what else asks the database", () => {
	it("Better Auth's endpoint answers 500, and logs nothing of what it was asked to store", async () => {
		const person = await newPerson();
		const slug = "a-slug-nobody-should-log";

		const from = id.logs.length;
		const answer = await without("organization", async () =>
			answerOf(await api("/organization/create", { who: person, body: { name: "Quiet", slug } })),
		);

		expect(answer.status).toBe(500);
		expect(answer.everything).not.toContain(slug);
		expectNoStatement(answer.everything);
		expect(loggedSince(from)).not.toContain(slug);
		expectNoStatementValues(loggedSince(from), person);
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: organization",
		);
	});

	it("signing in with a password answers 500 and not that the password was wrong", async () => {
		const person = await newPerson();

		const from = id.logs.length;
		const answer = await without("account", async () =>
			answerOf(await api("/sign-in/email", { body: { email: person.email, password: PASSWORD } })),
		);

		expect(answer.status).toBe(500);
		expect(answer.everything).not.toContain("session_token");
		expectNoStatement(answer.everything);
		expectNoStatementValues(loggedSince(from), person);
	});

	// The runtime reports a failed run by its message, so that is where a statement would be.
	it("the daily run logs the kind and the reference, and does its work the next day", async () => {
		await id.db
			.prepare("INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)")
			.bind("long-expired", "a-code-nobody-used", "what-it-stood-for", 1)
			.run();
		const held = async () =>
			(
				await id.db
					.prepare("SELECT count(*) AS n FROM verification WHERE id = ?")
					.bind("long-expired")
					.first<{ n: number }>()
			)?.n;

		const from = id.logs.length;
		// The sessions go first, so nothing of this run reaches the row.
		await without("session", () => id.runCron().catch(() => {}));

		const logged = loggedSince(from);
		expect(failuresSince(from).map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: session",
		]);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params:");
		// Its deletes are writes: sent once each.
		expect(logged).not.toMatch(/a read failed .* and is sent again/);
		expect(await held()).toBe(1);

		await id.runCron();
		expect(await held()).toBe(0);
	});
});

// The two places where the provider catches a failed read itself and answers in words of its own.
// The words are fixed ones, and none is the database's.
describe("where the provider answers a failed read itself", () => {
	it.each(["session", "user"])(
		"an app asking quietly is told nobody is signed in when %s cannot be read, and gets no code",
		async (table) => {
			const person = await newPerson();
			const app = await firstPartyApp();
			const asked = await authorizeRequest(app, person, { prompt: "none" });

			const from = id.logs.length;
			const answer = await without(table, async () => answerOf(await asked.send()));

			// It fails closed: the app is told to ask the person to sign in.
			const sent = whereSent(answer);
			expect(sent.host).toBe(app.host);
			expect(sent.searchParams.get("error")).toBe("login_required");
			expect(sent.searchParams.get("error_description")).toBe("authentication required");
			expect(sent.searchParams.get("state")).toBe(asked.state);
			expectNoTokens(answer);
			expectNoStatement(answer.everything);
			expectNoStatementValues(loggedSince(from), person);
			expect(failuresSince(from).length).toBeGreaterThan(0);

			// With the table back, the same request gets its code.
			expect(whereSent(await answerOf(await asked.send())).searchParams.get("code")).toBeTruthy();
		},
	);

	it("signing out of an app answers in fixed words, and signs nobody out by half", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const returning = await withACode(app, person);
		const tokens = await tokensFrom(app, returning, await tokenRequest(app, returning));
		const endSession = () =>
			id.fetch(`${as.end_session_endpoint}?id_token_hint=${tokens.id_token}`, {
				headers: { cookie: person.cookie, "cf-connecting-ip": newClient() },
			});
		const said = async (table: string) => {
			const from = id.logs.length;
			const answer = await without(table, async () => answerOf(await endSession()));
			expectNoStatement(answer.everything);
			expectNoStatementValues(loggedSince(from), person);
			expect(loggedSince(from)).not.toContain(app.clientId);
			expect(answer.location).toBeNull();
			return { status: answer.status, ...(JSON.parse(answer.text) as object) };
		};

		expect(await said("session")).toEqual({
			status: 500,
			error: "server_error",
			error_description: "Unable to read the current session",
		});
		expect(await said("oauth_client")).toEqual({
			status: 500,
			error: "server_error",
			error_description: "Unable to resolve the logout client",
		});
		// A key that cannot be read is a hint that cannot be checked.
		expect(await said("jwks")).toEqual({
			status: 401,
			error: "invalid_token",
			error_description: "The id_token_hint is invalid",
		});

		// Still signed in after all three.
		expect((await serverFn("getSession", person.cookie)).text).toContain(person.email);
	});
});

// `src/start.ts` adds a middleware to server functions, and a start instance replaces the
// framework's defaults, its guard against requests another site made among them. So the guard is
// listed there, and this holds it there. Other sites do call the provider's endpoints, which are
// no server functions.
describe("a server function called from another site", () => {
	it.each([
		["a cross-site request", { "sec-fetch-site": "cross-site" }],
		["a same-site request from another host", { "sec-fetch-site": "same-site" }],
		["another origin", { origin: "https://elsewhere.test" }],
		["another origin's page", { referer: "https://elsewhere.test/page" }],
	])("is refused, and its handler does not run: %s", async (_what, from) => {
		const person = await newPerson();

		const logged = id.logs.length;
		// The handler reads the session first, which would fail and say so in the log.
		const answer = await without("session", () => serverFn("getSession", person.cookie, from));

		expect(answer.status).toBe(403);
		expect(answer.text).toBe("Forbidden");
		expect(failuresSince(logged)).toEqual([]);
	});

	it.each([
		["the browser saying so", { "sec-fetch-site": "same-origin" }],
		["its origin", { origin }],
		["its page's address", { referer: `${origin}/account` }],
	])("answers its own page as before, by %s", async (_what, from) => {
		const person = await newPerson();

		const answer = await serverFn("getSession", person.cookie, from);

		expect(answer.status).toBe(200);
		expect(answer.text).toContain(person.email);
	});

	it("leaves the provider's endpoints to other origins, as apps call them", async () => {
		const person = await newPerson();
		const app = await firstPartyApp();
		const elsewhere = { origin: `https://${app.host}`, "sec-fetch-site": "cross-site" };
		const fromElsewhere: typeof fetch = (input, init) =>
			appFetch(input, {
				...init,
				headers: { ...Object.fromEntries(new Headers(init?.headers)), ...elsewhere },
			});

		const discovery = await fromElsewhere(`${origin}/.well-known/openid-configuration`);
		expect(discovery.status).toBe(200);
		const keys = await fromElsewhere(as.jwks_uri ?? "");
		expect(((await keys.json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0);

		// A browser sent here from the app's page.
		const asked = await authorizeRequest(app, person);
		const location = whereSent(await answerOf(await asked.send(elsewhere)));
		expect(location.host).toBe(app.host);
		const returning = { ...asked, location };

		const exchanged = await oauth.authorizationCodeGrantRequest(
			as,
			app.client,
			app.auth,
			oauth.validateAuthResponse(as, app.client, location, asked.state),
			app.redirectUri,
			asked.verifier,
			{ [oauth.customFetch]: fromElsewhere },
		);
		const tokens = await tokensFrom(app, returning, exchanged);
		expect(tokens.access_token).toMatch(/^gwid_at_/);

		const userinfo = await fromElsewhere(as.userinfo_endpoint ?? "", {
			headers: { authorization: `Bearer ${tokens.access_token}` },
		});
		expect(await userinfo.json()).toMatchObject({ email: person.email });
	});
});
