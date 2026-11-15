import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { FakeAuthenticator } from "./fake-authenticator";
import { type GitHubPerson, gitHubCode, startId } from "./id-worker";
import { totp } from "./totp";

// A workspace that requires two-factor sign-in, through the public routes of the built Worker, with
// a real OIDC client library as the app. Every test of the check has someone it refuses, as the check
// for who may sign in does: "A workspace that requires two-factor sign-in" in docs/architecture.md.

const origin = "https://id.test";
const issuer = new URL(origin);
const PASSWORD = "a-long-password-for-tests";
const SCOPE = "openid profile email offline_access";

let id: Awaited<ReturnType<typeof startId>>;
let as: oauth.AuthorizationServer;

const appFetch: typeof fetch = (input, init) =>
	id.fetch(input as string, {
		...init,
		headers: {
			...Object.fromEntries(new Headers(init?.headers)),
			"cf-connecting-ip": "198.51.100.1",
		},
	});

const fromApp = { [oauth.customFetch]: appFetch };

beforeAll(async () => {
	id = await startId(origin, { github: true });
	const response = await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp });
	as = await oauth.processDiscoveryResponse(issuer, response);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each request comes from an address of its own, so rate limits stay out of the way. */
function newClient() {
	const n = ++clients;
	return `203.0.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

function api(path: string, init: { cookie?: string | undefined; body?: object } = {}) {
	const { cookie, body } = init;
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

async function errorCode(response: Response) {
	return ((await response.clone().json()) as { code?: string }).code;
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

interface Person {
	email: string;
	/** The session they are using now. Signing in again replaces it. */
	cookie: string;
	userId: string;
}

let people = 0;

/** Someone with a password, in the session that choosing it left them: made by a sign-up code. */
async function newPerson(): Promise<Person> {
	const email = `two-factor-rule-${++people}@example.com`;
	await api("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	const person = { email, cookie: cookieOf(entered), userId: user.id };
	const chosen = await api("/account/first-password", {
		cookie: person.cookie,
		body: { newPassword: PASSWORD },
	});
	expect(chosen.status).toBe(200);
	return person;
}

/** How the session behind a cookie says it was made, as the database holds it. */
async function methodOf(cookie: string): Promise<string | null | undefined> {
	const reply = await api("/get-session", { cookie });
	const signedIn = (await reply.json()) as { session: { id: string } } | null;
	if (!signedIn) return undefined;
	const row = await id.db
		.prepare("SELECT sign_in_method FROM session WHERE id = ?")
		.bind(signedIn.session.id)
		.first<{ sign_in_method: string | null }>();
	return row?.sign_in_method;
}

/** A new sign-in with the password alone, which is all it takes while two-factor is off. */
async function signInWithPassword(person: Person) {
	const response = await api("/sign-in/email", {
		body: { email: person.email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	person.cookie = cookieOf(response);
}

/** Turns two-factor sign-in on. The session is replaced in doing so, which `person` follows. */
async function enrol(person: Person) {
	const asked = await api("/two-factor/enable", {
		cookie: person.cookie,
		body: { password: PASSWORD },
	});
	expect(asked.status).toBe(200);
	const { totpURI, backupCodes } = (await asked.json()) as {
		totpURI: string;
		backupCodes: string[];
	};
	const key = new URL(totpURI).searchParams.get("secret") ?? "";
	const confirmed = await api("/two-factor/verify-totp", {
		cookie: person.cookie,
		body: { code: totp(key) },
	});
	expect(confirmed.status).toBe(200);
	person.cookie = cookieOf(confirmed);
	return { key, recoveryCodes: backupCodes };
}

/** The right password, for someone who then owes a code. What comes back is the challenge. */
async function givePassword(person: Person) {
	const response = await api("/sign-in/email", {
		body: { email: person.email, password: PASSWORD },
	});
	expect(
		((await response.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect,
	).toBe(true);
	return cookieOf(response);
}

/**
 * A new sign-in with the password and a code. A code works once, and the one that turned two-factor
 * on may be this half minute's, so this offers the next step's, which the server takes as well.
 */
async function signInWithCode(person: Person, key: string, steps = 1) {
	const challenge = await givePassword(person);
	const response = await api("/two-factor/verify-totp", {
		cookie: challenge,
		body: { code: totp(key, { steps }) },
	});
	expect(response.status).toBe(200);
	person.cookie = cookieOf(response);
}

async function signInWithRecoveryCode(person: Person, code: string) {
	const challenge = await givePassword(person);
	const response = await api("/two-factor/verify-backup-code", {
		cookie: challenge,
		body: { code },
	});
	expect(response.status).toBe(200);
	person.cookie = cookieOf(response);
}

/** Adds a passkey, then signs in with it from a new device. */
async function signInWithPasskey(person: Person) {
	const authenticator = new FakeAuthenticator(origin);
	const asked = await api("/passkey/generate-register-options", { cookie: person.cookie });
	expect(asked.status).toBe(200);
	const added = await api("/passkey/verify-registration", {
		cookie: `${person.cookie}; ${cookieOf(asked)}`,
		body: { response: authenticator.register(await asked.clone().json()) },
	});
	expect(added.status).toBe(200);

	const challenge = await api("/passkey/generate-authenticate-options");
	expect(challenge.status).toBe(200);
	const response = await api("/passkey/verify-authentication", {
		cookie: cookieOf(challenge),
		body: { response: authenticator.signIn(await challenge.clone().json()) },
	});
	expect(response.status).toBe(200);
	person.cookie = cookieOf(response);
}

let gitHubIds = 5000;

/** Someone whose account GitHub made, signed in by GitHub and nothing else. */
async function newPersonFromGitHub(): Promise<Person> {
	const number = ++gitHubIds;
	const email = `github-rule-${number}@example.com`;
	const someone: GitHubPerson = {
		id: number,
		login: `octo-${number}`,
		name: "Octo",
		emails: [{ email, primary: true, verified: true }],
	};
	const started = await api("/sign-in/social", {
		body: { provider: "github", callbackURL: "/account" },
	});
	const { url } = (await started.json()) as { url: string };
	const state = new URL(url).searchParams.get("state") ?? "";
	const back = await id.fetch(
		`${origin}/api/auth/callback/github?${new URLSearchParams({ code: gitHubCode(someone), state })}`,
		{ headers: { "cf-connecting-ip": newClient(), cookie: cookieOf(started) } },
	);
	const cookie = cookieOf(back);
	const reply = await api("/get-session", { cookie });
	const { user } = (await reply.json()) as { user: { id: string } };
	return { email, cookie, userId: user.id };
}

let slugs = 0;

async function newWorkspace(owner: Person, name = "Acme") {
	const slug = `two-factor-workspace-${++slugs}`;
	const response = await api("/organization/create", {
		cookie: owner.cookie,
		body: { name, slug },
	});
	expect(response.status).toBe(200);
	const { id: workspaceId } = (await response.json()) as { id: string };
	return { id: workspaceId, slug, name };
}

type Workspace = Awaited<ReturnType<typeof newWorkspace>>;

async function details(person: Person, workspace: Workspace) {
	const response = await api(`/workspaces/get?slug=${workspace.slug}`, { cookie: person.cookie });
	expect(response.status).toBe(200);
	return (await response.json()) as {
		workspace: { requireTwoFactor: boolean };
		you: { memberId: string; twoFactors: boolean };
	};
}

/** Brings someone in, by the invitation that a real member would get. */
async function join(person: Person, workspace: Workspace, by: Person, role = "member") {
	const invited = await api("/organization/invite-member", {
		cookie: by.cookie,
		body: { organizationId: workspace.id, email: person.email, role },
	});
	expect(invited.status).toBe(200);
	const { id: invitationId } = (await invited.json()) as { id: string };
	const accepted = await api("/organization/accept-invitation", {
		cookie: person.cookie,
		body: { invitationId },
	});
	expect(accepted.status).toBe(200);
}

let hosts = 0;

async function newApp(owner: Person, workspace: Workspace, name = `Tool ${hosts + 1}`) {
	const host = `rule-${++hosts}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const response = await api("/workspaces/apps/add", {
		cookie: owner.cookie,
		body: { organizationId: workspace.id, name, redirectUris: [redirectUri] },
	});
	expect(response.status).toBe(200);
	const { clientId, clientSecret } = (await response.json()) as {
		clientId: string;
		clientSecret: string;
	};
	return {
		name,
		host,
		redirectUri,
		clientId,
		client: { client_id: clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(clientSecret),
	};
}

type App = Awaited<ReturnType<typeof newApp>>;

/** An app everyone can use, which has no workspace to ask anything on its behalf. */
async function firstPartyApp(): Promise<App> {
	const host = `rule-first-party-${++hosts}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const made = appRow({
		app: `rule-first-party-${hosts}`,
		name: "Ours",
		redirectUris: [redirectUri],
	});
	await id.db.prepare(insertStatement(made.row)).run();
	return {
		name: "Ours",
		host,
		redirectUri,
		clientId: made.clientId,
		client: { client_id: made.clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(made.clientSecret),
	};
}

/** Miniflare's fetch is not a navigation, so a request can be told where to go rather than sent. */
async function whereAnswered(response: Response) {
	const told =
		response.status === 200 ? ((await response.clone().json()) as { url: string }) : null;
	return new URL(response.headers.get("location") ?? told?.url ?? "/nowhere", origin);
}

async function authorize(app: App, person: Person, params: Record<string, string> = {}) {
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
		headers: { "cf-connecting-ip": newClient(), cookie: person.cookie },
	});
	return { location: await whereAnswered(response), state, nonce, verifier };
}

type Authorized = Awaited<ReturnType<typeof authorize>>;

/** Says yes on the consent page the first time, and leaves the person where their browser would go. */
async function arrive(app: App, person: Person): Promise<Authorized> {
	const asked = await authorize(app, person);
	if (asked.location.pathname !== "/consent") return asked;
	const answered = await api("/oauth2/consent", {
		cookie: person.cookie,
		body: { accept: true, oauth_query: asked.location.search.slice(1) },
	});
	expect(answered.status).toBe(200);
	const { url } = (await answered.json()) as { url: string };
	return { ...asked, location: new URL(url) };
}

async function exchange(app: App, authorized: Authorized) {
	const params = oauth.validateAuthResponse(as, app.client, authorized.location, authorized.state);
	const response = await oauth.authorizationCodeGrantRequest(
		as,
		app.client,
		app.auth,
		params,
		app.redirectUri,
		authorized.verifier,
		fromApp,
	);
	return oauth.processAuthorizationCodeResponse(as, app.client, response, {
		expectedNonce: authorized.nonce,
		requireIdToken: true,
	});
}

/** Asked, agrees and arrives, with tokens to show for it. */
async function signInToApp(app: App, person: Person) {
	const arrived = await arrive(app, person);
	expect(arrived.location.host).toBe(app.host);
	return exchange(app, arrived);
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

/** Turned away with no code, and still on this server. The provider knows one page for that. */
function expectRefused(authorized: Authorized, app: App) {
	expect(authorized.location.searchParams.has("code")).toBe(false);
	expect(authorized.location.host).not.toBe(app.host);
	expect(authorized.location.pathname).toBe("/no-access");
}

/** Opens a page as the person's browser would, and says what came back. */
async function open(location: URL | string, person: Person) {
	const response = await id.fetch(new URL(location, origin), {
		headers: { "cf-connecting-ip": newClient(), cookie: person.cookie, accept: "text/html" },
	});
	const next = response.headers.get("location");
	return {
		status: response.status,
		redirect: next ? new URL(next, origin) : null,
		// React puts a comment between pieces of text, which is no part of what someone reads.
		html: (await response.text()).replaceAll("<!-- -->", ""),
	};
}

function setRule(person: Person, workspace: Workspace, required: boolean, more: object = {}) {
	return api("/workspaces/require-two-factor", {
		cookie: person.cookie,
		body: { organizationId: workspace.id, required, ...more },
	});
}

async function ruleOf(workspace: Workspace) {
	const row = await id.db
		.prepare("SELECT require_two_factor FROM organization WHERE id = ?")
		.bind(workspace.id)
		.first<{ require_two_factor: number | null }>();
	return row?.require_two_factor;
}

/**
 * A workspace with an app, whose owner signed in with a code and can therefore turn the rule on, and
 * a member who has a password and nothing else.
 */
async function workspaceWithAMember() {
	const owner = await newPerson();
	await enrol(owner);
	const workspace = await newWorkspace(owner);
	const app = await newApp(owner, workspace);
	const member = await newPerson();
	await join(member, workspace, owner);
	await signInWithPassword(member);
	return { owner, workspace, app, member };
}

async function requireTwoFactor(owner: Person, workspace: Workspace) {
	const turned = await setRule(owner, workspace, true);
	expect(turned.status).toBe(200);
}

describe("how a session was made", () => {
	it("is kept on the session, for each way of signing in", async () => {
		const person = await newPerson();
		expect(await methodOf(person.cookie)).toBe("code");

		await signInWithPassword(person);
		expect(await methodOf(person.cookie)).toBe("password");

		await signInWithPasskey(person);
		expect(await methodOf(person.cookie)).toBe("passkey");

		await signInWithPassword(person);
		const { key, recoveryCodes } = await enrol(person);
		// The password and a code were both just shown, as a sign-in with both would.
		expect(await methodOf(person.cookie)).toBe("totp");

		await signInWithCode(person, key);
		expect(await methodOf(person.cookie)).toBe("totp");

		await signInWithRecoveryCode(person, recoveryCodes[0] ?? "");
		expect(await methodOf(person.cookie)).toBe("recovery_code");

		expect(await methodOf((await newPersonFromGitHub()).cookie)).toBe("github");
	});

	it("is nothing a request can say for itself", async () => {
		const person = await newPerson();
		await signInWithPassword(person);

		const claimed = await api("/update-session", {
			cookie: person.cookie,
			body: { signInMethod: "passkey" },
		});
		expect(claimed.status).toBe(400);
		expect(await methodOf(person.cookie)).toBe("password");
	});

	it("follows the session that replaces one, and loses the code when two-factor goes", async () => {
		const person = await newPerson();
		await signInWithPassword(person);
		await enrol(person);

		const changed = await api("/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` },
		});
		expect(changed.status).toBe(200);
		person.cookie = cookieOf(changed);
		expect(await methodOf(person.cookie)).toBe("totp");

		const turnedOff = await api("/two-factor/disable", {
			cookie: person.cookie,
			body: { password: `${PASSWORD}-2` },
		});
		expect(turnedOff.status).toBe(200);
		person.cookie = cookieOf(turnedOff);
		expect(await methodOf(person.cookie)).toBe("password");
	});
});

describe("a workspace that requires two-factor sign-in", () => {
	it("asks nothing until someone turns it on", async () => {
		const { workspace, app, member } = await workspaceWithAMember();
		expect(await ruleOf(workspace)).toBe(0);

		const tokens = await signInToApp(app, member);
		expect((await refresh(app, tokens.refresh_token)).access_token).toBeTruthy();
	});

	it("refuses a password alone at authorization and on refresh, then admits a second factor", async () => {
		const { owner, workspace, app, member } = await workspaceWithAMember();
		const before = await signInToApp(app, member);
		await requireTwoFactor(owner, workspace);

		// At authorization: no code, and the page for someone who can do something about it.
		const refused = await authorize(app, member);
		expectRefused(refused, app);
		const sent = await open(refused.location, member);
		expect(sent.redirect?.pathname).toBe("/second-factor");
		const page = await open(sent.redirect ?? "/nowhere", member);
		expect(page.status).toBe(200);
		expect(page.html).toContain("Two-factor sign-in needed");
		expect(page.html).toContain(`${workspace.name} asks everyone to sign in with a second factor`);
		expect(page.html).toContain("Signing in with GitHub does not count by itself");
		// Nothing to sign in again with yet, so it leads to where they can get one.
		expect(page.html).toContain('href="/account"');
		expect(page.html).not.toContain("Sign in again</a>");
		await id.auditEventRecorded(member.userId, {
			type: "refused",
			app: app.clientId,
			workspace_id: workspace.id,
			detail: "authorization+two_factor",
		});

		// An app that asked to show nothing is told so, and gets no code either.
		const quiet = await authorize(app, member, { prompt: "none" });
		expect(quiet.location.host).toBe(app.host);
		expect(quiet.location.searchParams.has("code")).toBe(false);
		expect(quiet.location.searchParams.get("error")).toBe("interaction_required");

		// On refresh: what they held from before the rule buys nothing more.
		await expect(refresh(app, before.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
			error_description: "This app's workspace asks for two-factor sign-in",
		});
		await id.auditEventRecorded(member.userId, {
			type: "refused",
			app: app.clientId,
			detail: "refresh_token+two_factor",
		});

		// A real second factor: an authenticator, then the password and its code.
		const { key } = await enrol(member);
		await signInWithCode(member, key);
		const after = await signInToApp(app, member);
		expect((await refresh(app, after.refresh_token)).access_token).toBeTruthy();
		// The token from the session that showed one factor stays refused.
		await expect(refresh(app, before.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
	});

	it("offers signing in again to someone who has a second factor and did not use it", async () => {
		const { owner, workspace, app, member } = await workspaceWithAMember();
		await requireTwoFactor(owner, workspace);
		// A passkey, and then a sign-in that did not use it.
		await signInWithPasskey(member);
		await signInWithPassword(member);

		const refused = await authorize(app, member);
		expectRefused(refused, app);
		const page = await open((await open(refused.location, member)).redirect ?? "/nowhere", member);
		expect(page.html).toContain("sign in again with it");
		const again = /href="([^"]*)"[^>]*>Sign in again/
			.exec(page.html)?.[1]
			?.replaceAll("&amp;", "&");
		const asks = new URL(again ?? "/nowhere", origin);
		expect(asks.pathname).toBe("/api/auth/oauth2/authorize");
		expect(asks.searchParams.get("prompt")).toBe("login");
		expect(asks.searchParams.get("client_id")).toBe(app.clientId);
		expect(asks.searchParams.has("sig")).toBe(false);

		// It asks for a new sign-in though they are signed in, and signs nobody out to do it.
		const asked = await id.fetch(asks, {
			headers: { "cf-connecting-ip": newClient(), cookie: member.cookie },
		});
		expect((await whereAnswered(asked)).pathname).toBe("/login");
		expect(await methodOf(member.cookie)).toBe("password");
	});

	it("does not take a code handed out before it was turned on", async () => {
		const { owner, workspace, app, member } = await workspaceWithAMember();
		const handed = await arrive(app, member);
		expect(handed.location.searchParams.has("code")).toBe(true);

		await requireTwoFactor(owner, workspace);

		await expect(exchange(app, handed)).rejects.toMatchObject({ error: "invalid_grant" });
		await id.auditEventRecorded(member.userId, {
			type: "refused",
			app: app.clientId,
			detail: "authorization_code+two_factor",
		});
	});

	it("admits a passkey and a recovery code, and refuses GitHub alone", async () => {
		const owner = await newPerson();
		const { recoveryCodes } = await enrol(owner);
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const withPasskey = await newPerson();
		const fromGitHub = await newPersonFromGitHub();
		await join(withPasskey, workspace, owner);
		await join(fromGitHub, workspace, owner);
		await requireTwoFactor(owner, workspace);

		// GitHub may have asked for a code of its own, which this server cannot see.
		const refused = await authorize(app, fromGitHub);
		expectRefused(refused, app);
		expect((await open(refused.location, fromGitHub)).redirect?.pathname).toBe("/second-factor");

		await signInWithPasskey(withPasskey);
		expect((await signInToApp(app, withPasskey)).access_token).toBeTruthy();

		// The same person from GitHub, once they have shown a second factor here.
		await signInWithPasskey(fromGitHub);
		expect((await signInToApp(app, fromGitHub)).access_token).toBeTruthy();

		await signInWithRecoveryCode(owner, recoveryCodes[0] ?? "");
		expect(await methodOf(owner.cookie)).toBe("recovery_code");
		expect((await signInToApp(app, owner)).access_token).toBeTruthy();
	});

	it("refuses a session from before sessions said how they were made", async () => {
		const { owner, workspace, app } = await workspaceWithAMember();
		await requireTwoFactor(owner, workspace);
		// The owner signed in with a code, and passes.
		expect((await signInToApp(app, owner)).access_token).toBeTruthy();

		// As a row made before the column is: nothing in it.
		await id.db
			.prepare("UPDATE session SET sign_in_method = NULL WHERE user_id = ?")
			.bind(owner.userId)
			.run();

		const refused = await authorize(app, owner);
		expectRefused(refused, app);
		expect((await open(refused.location, owner)).redirect?.pathname).toBe("/second-factor");
	});

	it("refuses a refresh once the session behind it has ended, and only where it is on", async () => {
		const { owner, workspace, app } = await workspaceWithAMember();
		const elsewhere = await newWorkspace(owner, "Elsewhere");
		const unasked = await newApp(owner, elsewhere);
		await requireTwoFactor(owner, workspace);
		const asked = await signInToApp(app, owner);
		const free = await signInToApp(unasked, owner);

		await id.db.prepare("DELETE FROM session WHERE user_id = ?").bind(owner.userId).run();

		// Nothing is left to say how they signed in, so this cannot be shown to have been two factors.
		await expect(refresh(app, asked.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		// A workspace that has not asked goes on as it always has.
		expect((await refresh(unasked, free.refresh_token)).access_token).toBeTruthy();
	});

	it("tells someone outside the workspace nothing, and leaves an app with no workspace alone", async () => {
		const { owner, workspace, app, member } = await workspaceWithAMember();
		await requireTwoFactor(owner, workspace);
		const outsider = await newPerson();
		await signInWithPassword(outsider);

		const refused = await authorize(app, outsider);
		expectRefused(refused, app);
		// The page that names no app, as before: not the one that would say this workspace has a rule.
		const page = await open(refused.location, outsider);
		expect(page.redirect).toBeNull();
		expect(page.html).toContain("You do not have access");
		expect(page.html).not.toContain(workspace.name);
		const direct = await open(`/second-factor?client_id=${app.clientId}`, outsider);
		expect(direct.redirect?.pathname).toBe("/no-access");
		await id.auditEventRecorded(outsider.userId, { type: "refused", detail: "authorization" });

		// The member is refused by their workspace's app, and not by one that belongs to nobody.
		expectRefused(await authorize(app, member), app);
		const ours = await firstPartyApp();
		const arrived = await authorize(ours, member);
		expect(arrived.location.host).toBe(ours.host);
		expect((await exchange(ours, arrived)).access_token).toBeTruthy();
	});
});

describe("turning the rule on and off", () => {
	it("is for owners and admins, and for nobody outside", async () => {
		const { owner, workspace, member } = await workspaceWithAMember();
		const { key } = await enrol(member);
		await signInWithCode(member, key);
		const outsider = await newPerson();

		const byMember = await setRule(member, workspace, true);
		expect(byMember.status).toBe(403);
		expect(await errorCode(byMember)).toBe("NOT_ALLOWED");
		const byOutsider = await setRule(outsider, workspace, true);
		expect(byOutsider.status).toBe(404);
		expect(await errorCode(byOutsider)).toBe("WORKSPACE_NOT_FOUND");
		expect((await setRule({ ...owner, cookie: "" }, workspace, true)).status).toBe(401);
		expect(await ruleOf(workspace)).toBe(0);

		const admin = await newPerson();
		await join(admin, workspace, owner, "admin");
		await enrol(admin);
		expect((await setRule(admin, workspace, true)).status).toBe(200);
		expect(await ruleOf(workspace)).toBe(1);
	});

	it("refuses an admin whose own session would not pass, in both directions", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		await signInWithPassword(owner);

		// The page is told, so that it can say so before anyone presses anything.
		expect(await details(owner, workspace)).toMatchObject({
			workspace: { requireTwoFactor: false },
			you: { twoFactors: false },
		});
		const locking = await setRule(owner, workspace, true);
		expect(locking.status).toBe(403);
		expect(await errorCode(locking)).toBe("SECOND_FACTOR_FIRST");
		expect(await ruleOf(workspace)).toBe(0);
		// Nothing changed for them: their own app still lets them in.
		expect((await signInToApp(app, owner)).access_token).toBeTruthy();

		await enrol(owner);
		expect((await details(owner, workspace)).you.twoFactors).toBe(true);
		expect((await setRule(owner, workspace, true)).status).toBe(200);
		expect(await details(owner, workspace)).toMatchObject({
			workspace: { requireTwoFactor: true },
		});
		// And they are not outside the moment it is on.
		expect((await signInToApp(app, owner)).access_token).toBeTruthy();

		// A cookie the rule would refuse cannot take the rule away.
		const weaker = { ...owner };
		await api("/two-factor/disable", { cookie: owner.cookie, body: { password: PASSWORD } }).then(
			(response) => {
				expect(response.status).toBe(200);
				weaker.cookie = cookieOf(response);
			},
		);
		const unlocking = await setRule(weaker, workspace, false);
		expect(unlocking.status).toBe(403);
		expect(await errorCode(unlocking)).toBe("SECOND_FACTOR_FIRST");
		expect(await ruleOf(workspace)).toBe(1);
	});

	it("wants a recent sign-in, and takes nothing but what it asks for", async () => {
		const { owner, workspace } = await workspaceWithAMember();

		const more = await setRule(owner, workspace, true, { metadata: "{}" });
		expect(more.status).toBe(400);
		const notABoolean = await api("/workspaces/require-two-factor", {
			cookie: owner.cookie,
			body: { organizationId: workspace.id, required: "yes" },
		});
		expect(notABoolean.status).toBe(400);
		// The organization plugin's own way to change a workspace does not reach it either.
		const throughThePlugin = await api("/organization/update", {
			cookie: owner.cookie,
			body: { organizationId: workspace.id, data: { name: "Acme", requireTwoFactor: true } },
		});
		expect(throughThePlugin.status).toBe(400);

		await id.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, owner.userId)
			.run();
		const stale = await setRule(owner, workspace, true);
		expect(stale.status).toBe(403);
		expect(await errorCode(stale)).toBe("SESSION_NOT_FRESH");
		expect(await ruleOf(workspace)).toBe(0);
	});

	it("is written down each time it changes, and lets a password back in once it is off", async () => {
		const { owner, workspace, app, member } = await workspaceWithAMember();

		await requireTwoFactor(owner, workspace);
		await id.auditEventRecorded(owner.userId, {
			type: "workspace_two_factor_changed",
			actor_id: owner.userId,
			workspace_id: workspace.id,
			detail: JSON.stringify({ workspace: workspace.name, required: true }),
		});
		expectRefused(await authorize(app, member), app);

		// Saying what it already says is no change.
		expect((await setRule(owner, workspace, true)).status).toBe(200);
		expect((await setRule(owner, workspace, false)).status).toBe(200);
		await id.auditEventRecorded(owner.userId, {
			type: "workspace_two_factor_changed",
			detail: JSON.stringify({ workspace: workspace.name, required: false }),
		});
		const changes = (await id.auditEvents(owner.userId)).filter(
			({ type }) => type === "workspace_two_factor_changed",
		);
		expect(changes).toHaveLength(2);
		expect((await signInToApp(app, member)).access_token).toBeTruthy();

		// The person who did it reads it in their own activity.
		const activity = await api("/account/activity", { cookie: owner.cookie });
		const { events } = (await activity.json()) as { events: { type: string; detail: string }[] };
		expect(events.filter(({ type }) => type === "workspace_two_factor_changed")).toHaveLength(2);
	});
});
