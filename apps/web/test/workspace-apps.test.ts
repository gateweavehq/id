import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement, workspaceAppRow } from "../src/server/auth/app-row";
import { startId } from "./id-worker";

// Apps a workspace adds, as their admins and their members meet them: a real OIDC client library
// against the built Worker. What the pages do with a person on the way is in e2e/workspaces.spec.ts.

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
	id = await startId(origin);
	const response = await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp });
	as = await oauth.processDiscoveryResponse(issuer, response);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each request can come from an address of its own, so rate limits stay out of the way. */
function newClient() {
	const n = ++clients;
	return `203.0.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

interface Who {
	cookie: string;
	client: string;
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

async function newPerson(name = "Ada") {
	const email = `app-person-${++people}@example.com`;
	const client = newClient();
	await api("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
	const otp = await codeSentTo(email);
	const entered = await api("/sign-in/email-otp", { body: { email, otp, name } });
	expect(entered.status).toBe(200);
	const { user } = (await entered.clone().json()) as { user: { id: string } };
	const who = { email, name, client, cookie: cookieOf(entered), userId: user.id };
	const chosen = await api("/account/first-password", { who, body: { newPassword: PASSWORD } });
	expect(chosen.status).toBe(200);
	return who;
}

type Person = Awaited<ReturnType<typeof newPerson>>;

let slugs = 0;

async function newWorkspace(owner: Person, name = "Acme") {
	const slug = `apps-workspace-${++slugs}`;
	const response = await api("/organization/create", { who: owner, body: { name, slug } });
	expect(response.status).toBe(200);
	const { id: workspaceId } = (await response.json()) as { id: string };
	return { id: workspaceId, slug, name };
}

type Workspace = Awaited<ReturnType<typeof newWorkspace>>;

async function details(who: Who, workspace: Workspace) {
	const response = await api(`/workspaces/get?slug=${workspace.slug}`, { who });
	expect(response.status).toBe(200);
	return (await response.json()) as {
		you: { memberId: string };
		apps: { clientId: string; name: string; redirectUris: string[] }[];
		appsEnabled: boolean;
	};
}

/** Brings someone in, by the invitation that a real member would get. */
async function join(person: Person, workspace: Workspace, by: Who, role = "member") {
	const invited = await api("/organization/invite-member", {
		who: by,
		body: { organizationId: workspace.id, email: person.email, role },
	});
	expect(invited.status).toBe(200);
	const { id: invitationId } = (await invited.json()) as { id: string };
	const accepted = await api("/organization/accept-invitation", {
		who: person,
		body: { invitationId },
	});
	expect(accepted.status).toBe(200);
	return (await details(person, workspace)).you.memberId;
}

async function remove(by: Who, workspace: Workspace, memberId: string) {
	const removed = await api("/organization/remove-member", {
		who: by,
		body: { organizationId: workspace.id, memberIdOrEmail: memberId },
	});
	expect(removed.status).toBe(200);
}

let hosts = 0;

async function newApp(owner: Who, workspace: Workspace, name = `Tool ${hosts + 1}`) {
	const host = `tool-${++hosts}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const response = await api("/workspaces/apps/add", {
		who: owner,
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
		clientSecret,
		client: { client_id: clientId } satisfies oauth.Client,
		auth: oauth.ClientSecretBasic(clientSecret),
	};
}

type App = Awaited<ReturnType<typeof newApp>>;

/** Miniflare's fetch is not a navigation, so a request can be told where to go rather than sent. */
async function whereAnswered(response: Response) {
	const told =
		response.status === 200 ? ((await response.clone().json()) as { url: string }) : null;
	return new URL(response.headers.get("location") ?? told?.url ?? "/nowhere", origin);
}

async function authorize(
	app: Pick<App, "clientId" | "redirectUri">,
	person: Who,
	params: Record<string, string> = {},
) {
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
	return { response, location: await whereAnswered(response), state, nonce, verifier };
}

type Authorized = Awaited<ReturnType<typeof authorize>>;

/** Says yes on the consent page, and leaves the person where their browser would go. */
async function agree(asked: Authorized, person: Who): Promise<Authorized> {
	expect(asked.location.pathname).toBe("/consent");
	const answered = await api("/oauth2/consent", {
		who: person,
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
	const tokens = await oauth.processAuthorizationCodeResponse(as, app.client, response, {
		expectedNonce: authorized.nonce,
		requireIdToken: true,
	});
	const claims = oauth.getValidatedIdTokenClaims(tokens);
	if (!claims) throw new Error("No ID token");
	return { tokens, claims };
}

/** Asked, agrees and arrives. */
async function signInToApp(app: App, person: Who) {
	return exchange(app, await agree(await authorize(app, person), person));
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

function userinfo(accessToken: string | undefined) {
	return appFetch(as.userinfo_endpoint ?? "", {
		headers: { authorization: `Bearer ${accessToken}` },
	});
}

function expectRefused(authorized: Authorized, app: App) {
	expect(authorized.location.searchParams.has("code")).toBe(false);
	expect(authorized.location.host).not.toBe(app.host);
	expect(authorized.location.pathname).toBe("/no-access");
}

function count(table: string, where: string, ...values: string[]) {
	return id.db
		.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
		.bind(...values)
		.first<number>("n");
}

function appRowIn(clientId: string) {
	return id.db
		.prepare("SELECT * FROM oauth_client WHERE client_id = ?")
		.bind(clientId)
		.first<Record<string, string | number | null>>();
}

/** Makes someone's session older than what asks for a recent sign-in will take. */
function ageSession(person: Person) {
	return id.db
		.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
		.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, person.userId)
		.run();
}

async function firstPartyApp(name = `First party ${++hosts}`) {
	const made = appRow({
		app: `first-party-${hosts}`,
		name,
		redirectUris: [`https://first-party-${hosts}.apps.test/callback`],
	});
	await id.db.prepare(insertStatement(made.row)).run();
	return { ...made, name };
}

describe("adding an app", () => {
	it("hands over the secret once, and keeps nothing it could show again", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);

		expect(app.clientSecret.startsWith("gwid_cs_")).toBe(true);
		const secret = app.clientSecret.slice("gwid_cs_".length);
		const row = await appRowIn(app.clientId);
		expect(JSON.stringify(row)).not.toContain(secret);

		const seen = await api(`/workspaces/get?slug=${workspace.slug}`, { who: owner });
		const text = await seen.text();
		expect(text).toContain(app.clientId);
		expect(text).not.toContain(secret);
		expect(text).not.toContain(String(row?.client_secret));
		expect((await details(owner, workspace)).apps).toEqual([
			{ clientId: app.clientId, name: app.name, redirectUris: [app.redirectUri] },
		]);
	});

	it("decides what makes the app safe itself", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		expect(await appRowIn(app.clientId)).toMatchObject({
			reference_id: workspace.id,
			skip_consent: 0,
			enable_end_session: 0,
			subject_type: "pairwise",
			require_pkce: 1,
			disabled: 0,
			backchannel_logout_uri: null,
			metadata: JSON.stringify({ app: app.clientId, workspace: workspace.id }),
		});
	});

	it.each([
		["skip_consent", { skip_consent: true }],
		["skipConsent", { skipConsent: true }],
		["metadata", { metadata: { app: "track" } }],
		["clientId", { clientId: "chosen-id" }],
		["scopes", { scopes: ["openid", "admin"] }],
	])("takes no %s from whoever asks", async (_name, extra) => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const response = await api("/workspaces/apps/add", {
			who: owner,
			body: {
				organizationId: workspace.id,
				name: "Tool",
				redirectUris: ["https://tool.apps.test/callback"],
				...extra,
			},
		});
		expect(response.status).toBe(400);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(0);
	});

	it.each([
		["this server", ["https://id.test/callback"]],
		["another port of this server", ["https://id.test:8443/callback"]],
		["plain http", ["http://tool.apps.test/callback"]],
		["a fragment", ["https://tool.apps.test/callback#here"]],
		["a name and a password", ["https://me:secret@tool.apps.test/callback"]],
		["what is not a URL", ["not a url"]],
		["a script", ["javascript:alert(1)"]],
		["two hosts", ["https://a.apps.test/callback", "https://b.apps.test/callback"]],
		["nothing", []],
		["too many", Array.from({ length: 6 }, (_, n) => `https://a.apps.test/${n}`)],
	])("refuses to send people to %s", async (_name, redirectUris) => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const response = await api("/workspaces/apps/add", {
			who: owner,
			body: { organizationId: workspace.id, name: "Tool", redirectUris },
		});
		expect(response.status).toBe(400);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(0);
	});

	it.each([
		["ours", "Gateweave"],
		["ours in other capitals", "GATEWEAVE id"],
		["ours with spaces between", "Gate weave"],
		["ours in other letters of the same look", "Ｇａｔｅｗｅａｖｅ"],
		["ours with something after it", "Gateweave Account"],
		["ours inside something", "The Gateweave Team"],
	])("keeps the name %s off the table", async (_name, name) => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const response = await api("/workspaces/apps/add", {
			who: owner,
			body: { organizationId: workspace.id, name, redirectUris: ["https://a.apps.test/callback"] },
		});
		expect(response.status).toBe(400);
	});

	it("keeps the name of an app everyone here can use off the table, then and later", async () => {
		const firstParty = await firstPartyApp("Sprocket Board");
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const refused = await api("/workspaces/apps/add", {
			who: owner,
			body: {
				organizationId: workspace.id,
				name: firstParty.name.toLowerCase(),
				redirectUris: ["https://a.apps.test/callback"],
			},
		});
		expect(refused.status).toBe(400);

		const app = await newApp(owner, workspace);
		const renamed = await api("/workspaces/apps/change", {
			who: owner,
			body: {
				organizationId: workspace.id,
				clientId: app.clientId,
				name: firstParty.name,
				redirectUris: [app.redirectUri],
			},
		});
		expect(renamed.status).toBe(400);
		expect((await appRowIn(app.clientId))?.name).toBe(app.name);
	});

	it("gets no address out of a name, or SQL into the database", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace, `Bobby'); DROP TABLE user; --`);
		expect((await appRowIn(app.clientId))?.name).toBe(`Bobby'); DROP TABLE user; --`);
		expect(await count("user", "id = ?", owner.userId)).toBe(1);
	});

	it("stops at as many apps as a workspace can hold", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		for (let n = 0; n < 20; n++) {
			const { row } = workspaceAppRow({
				workspace: workspace.id,
				name: `Filler ${n}`,
				redirectUris: [`https://filler-${n}.apps.test/callback`],
			});
			await id.db.prepare(insertStatement(row)).run();
		}
		const response = await api("/workspaces/apps/add", {
			who: owner,
			body: {
				organizationId: workspace.id,
				name: "One more",
				redirectUris: ["https://one-more.apps.test/callback"],
			},
		});
		expect(response.status).toBe(400);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(20);
	});

	it("leaves a line in the log of whoever did each thing, with names that outlast the app", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner, "Logged");
		const app = await newApp(owner, workspace, "Logged tool");
		const which = { organizationId: workspace.id, clientId: app.clientId };
		const detail = JSON.stringify({ workspace: "Logged", name: "Logged tool" });
		await id.auditEventRecorded(owner.userId, {
			type: "app_added",
			app: app.clientId,
			workspace_id: workspace.id,
			actor_id: owner.userId,
			detail: JSON.stringify({
				workspace: "Logged",
				name: "Logged tool",
				redirectUris: [app.redirectUri],
			}),
		});

		const changed = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: "Logged tool", redirectUris: [`${app.redirectUri}/2`] },
		});
		expect(changed.status).toBe(200);
		await id.auditEventRecorded(owner.userId, {
			type: "app_changed",
			app: app.clientId,
			detail: JSON.stringify({
				workspace: "Logged",
				name: "Logged tool",
				redirectUris: [`${app.redirectUri}/2`],
			}),
		});

		const replaced = await api("/workspaces/apps/replace-secret", { who: owner, body: which });
		expect(replaced.status).toBe(200);
		await id.auditEventRecorded(owner.userId, {
			type: "app_secret_replaced",
			app: app.clientId,
			detail,
		});

		const deleted = await api("/workspaces/apps/delete", { who: owner, body: which });
		expect(deleted.status).toBe(200);
		await id.auditEventRecorded(owner.userId, { type: "app_deleted", app: app.clientId, detail });
	});
});

describe("who can manage a workspace's apps", () => {
	/** Every action, each on this app, as this person would ask. */
	function actions(workspaceId: string, app: App): [string, string, object][] {
		const which = { organizationId: workspaceId, clientId: app.clientId };
		return [
			[
				"add",
				"/workspaces/apps/add",
				{
					organizationId: workspaceId,
					name: "Another",
					redirectUris: ["https://another.apps.test/callback"],
				},
			],
			[
				"change",
				"/workspaces/apps/change",
				{ ...which, name: "Taken over", redirectUris: [app.redirectUri] },
			],
			["replace the secret", "/workspaces/apps/replace-secret", which],
			["delete", "/workspaces/apps/delete", which],
		];
	}

	async function setting() {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		return { owner, workspace, app, before: await appRowIn(app.clientId) };
	}

	it("lets an admin do all of it", async () => {
		const { owner, workspace, app } = await setting();
		const admin = await newPerson();
		await join(admin, workspace, owner, "admin");
		for (const [, path, body] of actions(workspace.id, app)) {
			expect((await api(path, { who: admin, body })).status).toBe(200);
		}
	});

	it("shows a plain member none of the apps, and lets them do none of it", async () => {
		const { owner, workspace, app, before } = await setting();
		const member = await newPerson();
		await join(member, workspace, owner);
		expect((await details(member, workspace)).apps).toEqual([]);
		for (const [, path, body] of actions(workspace.id, app)) {
			const response = await api(path, { who: member, body });
			expect(response.status).toBe(403);
			expect(((await response.json()) as { code: string }).code).toBe("NOT_ALLOWED");
		}
		expect(await appRowIn(app.clientId)).toEqual(before);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(1);
	});

	it("tells someone outside what it tells them of a workspace that does not exist", async () => {
		const { workspace, app, before } = await setting();
		const stranger = await newPerson();
		for (const [, path, body] of actions(workspace.id, app)) {
			const here = await api(path, { who: stranger, body });
			const nowhere = await api(path, {
				who: stranger,
				body: { ...body, organizationId: "no-such-workspace" },
			});
			expect(here.status).toBe(404);
			expect(await here.json()).toEqual(await nowhere.json());
		}
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it("gives no one signed out anything", async () => {
		const { workspace, app, before } = await setting();
		for (const [, path, body] of actions(workspace.id, app)) {
			expect((await api(path, { body })).status).toBe(401);
		}
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it("does not let an admin of one workspace reach another's app through their own", async () => {
		const { app, before } = await setting();
		const rival = await newPerson();
		const theirs = await newWorkspace(rival, "Rival");
		for (const [name, path, body] of actions(theirs.id, app)) {
			if (name === "add") continue;
			const response = await api(path, { who: rival, body });
			expect(response.status).toBe(404);
			expect(((await response.json()) as { code: string }).code).toBe("APP_NOT_FOUND");
		}
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it("treats an app everyone can use as nothing to do with a workspace", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const { clientId } = await firstPartyApp();
		const before = await appRowIn(clientId);
		const which = { organizationId: workspace.id, clientId };
		for (const [path, body] of [
			["/workspaces/apps/change", { ...which, name: "Mine", redirectUris: ["https://a.test/b"] }],
			["/workspaces/apps/replace-secret", which],
			["/workspaces/apps/delete", which],
		] as const) {
			expect((await api(path, { who: owner, body })).status).toBe(404);
		}
		expect(await appRowIn(clientId)).toEqual(before);
	});

	it.each([
		["add", "/workspaces/apps/add"],
		["replace the secret", "/workspaces/apps/replace-secret"],
		["delete", "/workspaces/apps/delete"],
	])("wants someone who signed in recently to %s", async (_name, path) => {
		const { owner, workspace, app, before } = await setting();
		await ageSession(owner);
		const [, , body] = actions(workspace.id, app).find(([, each]) => each === path) ?? [];
		const response = await api(path, { who: owner, body: body ?? {} });
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code: string }).code).toBe("SESSION_NOT_FRESH");
		expect(await appRowIn(app.clientId)).toEqual(before);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(1);
	});
});

describe("the provider's own ways to manage apps", () => {
	it.each([
		["/oauth2/create-client", { redirect_uris: ["https://a.apps.test/callback"] }],
		["/oauth2/update-client", { client_id: "", update: { skip_consent: true } }],
		["/oauth2/delete-client", { client_id: "" }],
		["/oauth2/client/rotate-secret", { client_id: "" }],
	])("stay closed to an admin: %s", async (path, body) => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const before = await appRowIn(app.clientId);
		const response = await api(path, {
			who: owner,
			body: { ...body, ...("client_id" in body && { client_id: app.clientId }) },
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(await appRowIn(app.clientId)).toEqual(before);
		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(1);
	});

	it.each(["/oauth2/get-clients", "/oauth2/get-client"])(
		"show an admin nothing: %s",
		async (path) => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const app = await newApp(owner, workspace);
			const response = await api(`${path}?client_id=${app.clientId}`, { who: owner });
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(await response.text()).not.toContain(app.name);
		},
	);

	it.each(["/oauth2/public-client", "/oauth2/public-client-prelogin"])(
		"do not name any app to anyone who has its id: %s",
		async (path) => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const app = await newApp(owner, workspace);
			const stranger = await newPerson();
			const got = await api(`${path}?client_id=${app.clientId}`, { who: stranger });
			const posted = await api(path, { who: stranger, body: { client_id: app.clientId } });
			expect(got.status).toBe(404);
			expect(posted.status).toBe(404);
			expect(await got.text()).not.toContain(app.name);
			expect(await posted.text()).not.toContain(app.name);
		},
	);
});

describe("signing in to a workspace's app", () => {
	it("asks a member first, and then lets them through", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const member = await newPerson();
		await join(member, workspace, owner);

		const asked = await authorize(app, member);
		expect(asked.location.pathname).toBe("/consent");
		expect(asked.location.searchParams.has("code")).toBe(false);

		const { claims, tokens } = await exchange(app, await agree(asked, member));
		expect(claims.email).toBe(member.email);
		expect(tokens.refresh_token).toBeTruthy();
		await id.auditEventRecorded(member.userId, {
			type: "app_sign_in",
			app: app.clientId,
			workspace_id: workspace.id,
		});
		await id.auditEventRecorded(member.userId, {
			type: "consent_granted",
			app: app.clientId,
			workspace_id: workspace.id,
		});
	});

	it("does not ask again once they have said yes", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const first = await signInToApp(app, owner);

		const again = await authorize(app, owner);
		expect(again.location.host).toBe(app.host);
		const second = await exchange(app, again);
		expect(second.claims.sub).toBe(first.claims.sub);
	});

	it("asks again when the app wants more than they agreed to", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const first = await authorize(app, owner, { scope: "openid" });
		await exchange(app, await agree(first, owner));

		const asked = await authorize(app, owner, { scope: "openid email" });
		expect(asked.location.pathname).toBe("/consent");
		expect(asked.location.searchParams.has("code")).toBe(false);
	});

	it("gives a member an id of this app's own, and no link to their sessions", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const other = await newApp(owner, workspace);
		const here = await signInToApp(app, owner);
		const there = await signInToApp(other, owner);

		expect(here.claims.sub).not.toBe(owner.userId);
		expect(here.claims.sub).not.toBe(there.claims.sub);
		expect(here.claims).not.toHaveProperty("sid");
		expect(there.claims).not.toHaveProperty("sid");
	});

	it("takes a no as a no", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const asked = await authorize(app, owner);
		const answered = await api("/oauth2/consent", {
			who: owner,
			body: { accept: false, oauth_query: asked.location.search.slice(1) },
		});
		expect(answered.status).toBe(200);
		const { url } = (await answered.json()) as { url: string };
		expect(new URL(url).searchParams.has("code")).toBe(false);
		expect(new URL(url).searchParams.get("error")).toBe("access_denied");
	});

	it("refuses someone outside the workspace, without asking them", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const stranger = await newPerson();

		expectRefused(await authorize(app, stranger), app);
		await id.auditEventRecorded(stranger.userId, {
			type: "refused",
			app: app.clientId,
			workspace_id: workspace.id,
		});
	});

	it("refuses a member of another workspace", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const rival = await newPerson();
		await newWorkspace(rival, "Rival");
		expectRefused(await authorize(app, rival), app);
	});

	it("does not let someone outside agree their way in", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const stranger = await newPerson();
		const refused = await authorize(app, stranger);
		for (const [path, body] of [
			["/oauth2/consent", { accept: true }],
			["/oauth2/continue", { postLogin: true }],
			["/oauth2/continue", { selected: true }],
		] as const) {
			const response = await api(path, {
				who: stranger,
				body: { ...body, oauth_query: refused.location.search.slice(1) },
			});
			expect(await response.text()).not.toContain("code=");
		}
		expect(
			await count(
				"oauth_access_token",
				"user_id = ? AND client_id = ?",
				stranger.userId,
				app.clientId,
			),
		).toBe(0);
	});

	it("refuses a code issued to someone who has since been removed", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const member = await newPerson();
		const memberId = await join(member, workspace, owner);
		const agreed = await agree(await authorize(app, member), member);
		await remove(owner, workspace, memberId);
		await expect(exchange(app, agreed)).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("refuses an unreadable app, and an app whose workspace is gone from its row", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		await id.db
			.prepare("UPDATE oauth_client SET metadata = ? WHERE client_id = ?")
			.bind(JSON.stringify({ app: app.clientId, workspace: 7 }), app.clientId)
			.run();
		expectRefused(await authorize(app, owner), app);
	});

	it("still lets anyone with a verified address into an app everyone can use", async () => {
		const made = await firstPartyApp();
		const person = await newPerson();
		const url = new URL(as.authorization_endpoint ?? "");
		url.search = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: JSON.parse(made.row.redirect_uris)[0],
			response_type: "code",
			scope: SCOPE,
			state: "state",
			code_challenge: await oauth.calculatePKCECodeChallenge(oauth.generateRandomCodeVerifier()),
			code_challenge_method: "S256",
		}).toString();
		const response = await id.fetch(url, {
			headers: { "cf-connecting-ip": newClient(), cookie: person.cookie },
		});
		const { url: target } =
			response.status === 200 ? ((await response.clone().json()) as { url: string }) : { url: "" };
		const location = new URL(response.headers.get("location") ?? target ?? "/nowhere", origin);
		expect(location.searchParams.has("code")).toBe(true);
	});
});

describe("someone leaving a workspace", () => {
	async function member() {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const person = await newPerson();
		const memberId = await join(person, workspace, owner);
		const { tokens } = await signInToApp(app, person);
		return { owner, workspace, app, person, memberId, tokens };
	}

	function heldBy(person: Person, app: App) {
		return Promise.all(
			["oauth_access_token", "oauth_refresh_token", "oauth_consent"].map((table) =>
				count(table, "user_id = ? AND client_id = ?", person.userId, app.clientId),
			),
		);
	}

	it("loses the app at once when removed, with what they already hold", async () => {
		const { owner, workspace, app, person, memberId, tokens } = await member();
		expect((await userinfo(tokens.access_token)).status).toBe(200);
		expect(await heldBy(person, app)).toEqual([expect.any(Number), 1, 1]);

		await remove(owner, workspace, memberId);

		expect((await userinfo(tokens.access_token)).status).toBe(401);
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		expect(await heldBy(person, app)).toEqual([0, 0, 0]);
		expectRefused(await authorize(app, person), app);
	});

	it("loses an access token that came with no refresh token to take it along", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const person = await newPerson();
		const memberId = await join(person, workspace, owner);
		const asked = await authorize(app, person, { scope: "openid email" });
		const { tokens } = await exchange(app, await agree(asked, person));
		expect(tokens.refresh_token).toBeUndefined();
		expect((await userinfo(tokens.access_token)).status).toBe(200);

		await remove(owner, workspace, memberId);

		expect((await userinfo(tokens.access_token)).status).toBe(401);
	});

	it("loses the app at once when they leave by themselves", async () => {
		const { workspace, app, person, tokens } = await member();
		const left = await api("/organization/leave", {
			who: person,
			body: { organizationId: workspace.id },
		});
		expect(left.status).toBe(200);
		expect((await userinfo(tokens.access_token)).status).toBe(401);
		expect(await heldBy(person, app)).toEqual([0, 0, 0]);
	});

	it("is asked again if they are invited back", async () => {
		const { owner, workspace, app, person, memberId } = await member();
		await remove(owner, workspace, memberId);
		await join(person, workspace, owner);
		const asked = await authorize(app, person);
		expect(asked.location.pathname).toBe("/consent");
	});

	it("takes nothing from anyone else, or from their other workspaces", async () => {
		const { owner, workspace, app, person, memberId } = await member();
		const others = await signInToApp(app, owner);
		const elsewhere = await newWorkspace(owner, "Elsewhere");
		const elsewhereApp = await newApp(owner, elsewhere);
		await join(person, elsewhere, owner);
		const theirs = await signInToApp(elsewhereApp, person);

		await remove(owner, workspace, memberId);

		expect((await userinfo(others.tokens.access_token)).status).toBe(200);
		expect((await userinfo(theirs.tokens.access_token)).status).toBe(200);
		await refresh(elsewhereApp, theirs.tokens.refresh_token);
		// Neither is asked again, as what they agreed to still stands.
		expect((await authorize(app, owner)).location.host).toBe(app.host);
		expect((await authorize(elsewhereApp, person)).location.host).toBe(elsewhereApp.host);
	});
});

describe("changing an app", () => {
	async function anApp() {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		return {
			owner,
			workspace,
			app,
			which: { organizationId: workspace.id, clientId: app.clientId },
		};
	}

	it("changes its name and where on its host it sends people", async () => {
		const { owner, workspace, app, which } = await anApp();
		const moved = `https://${app.host}/elsewhere`;
		const response = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: "Renamed", redirectUris: [moved] },
		});
		expect(response.status).toBe(200);
		expect((await details(owner, workspace)).apps).toEqual([
			{ clientId: app.clientId, name: "Renamed", redirectUris: [moved] },
		]);

		const asked = await authorize({ ...app, redirectUri: moved }, owner);
		expect(asked.location.pathname).toBe("/consent");
		const old = await authorize(app, owner);
		expect(old.location.searchParams.has("code")).toBe(false);
		expect(old.location.pathname).not.toBe("/consent");
	});

	it("does not move it to another host, where people's consent and ids would not hold", async () => {
		const { owner, app, which } = await anApp();
		const before = await appRowIn(app.clientId);
		const response = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: app.name, redirectUris: ["https://elsewhere.apps.test/callback"] },
		});
		expect(response.status).toBe(400);
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it.each([
		["plain http", (host: string) => [`http://${host}/callback`]],
		["a fragment", (host: string) => [`https://${host}/callback#here`]],
		["a name and a password", (host: string) => [`https://me:secret@${host}/callback`]],
		["a second host", (host: string) => [`https://${host}/1`, "https://elsewhere.apps.test/1"]],
	])("holds a change on its own host to the same rules: %s", async (_name, uris) => {
		const { owner, app, which } = await anApp();
		const before = await appRowIn(app.clientId);
		const response = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: app.name, redirectUris: uris(app.host) },
		});
		expect(response.status).toBe(400);
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it("takes nothing else from whoever asks", async () => {
		const { owner, app, which } = await anApp();
		const before = await appRowIn(app.clientId);
		const response = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: app.name, redirectUris: [app.redirectUri], skip_consent: true },
		});
		expect(response.status).toBe(400);
		expect(await appRowIn(app.clientId)).toEqual(before);
	});

	it.each([["/workspaces/apps/replace-secret"], ["/workspaces/apps/delete"]])(
		"takes nothing but which app at %s",
		async (path) => {
			const { owner, app, which } = await anApp();
			const before = await appRowIn(app.clientId);
			const response = await api(path, { who: owner, body: { ...which, name: "Anything" } });
			expect(response.status).toBe(400);
			expect(await appRowIn(app.clientId)).toEqual(before);
		},
	);

	it("replaces the secret, and the old one stops working while people stay signed in", async () => {
		const { owner, app, which } = await anApp();
		const { tokens } = await signInToApp(app, owner);
		const response = await api("/workspaces/apps/replace-secret", { who: owner, body: which });
		expect(response.status).toBe(200);
		const { clientSecret } = (await response.json()) as { clientSecret: string };
		expect(clientSecret).not.toBe(app.clientSecret);

		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({ status: 401 });
		expect((await userinfo(tokens.access_token)).status).toBe(200);
		await refresh({ ...app, auth: oauth.ClientSecretBasic(clientSecret) }, tokens.refresh_token);
	});
});

describe("deleting", () => {
	it("an app ends everyone's access to it, and nobody else's", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const other = await newApp(owner, workspace);
		const { tokens } = await signInToApp(app, owner);
		const kept = await signInToApp(other, owner);

		const deleted = await api("/workspaces/apps/delete", {
			who: owner,
			body: { organizationId: workspace.id, clientId: app.clientId },
		});
		expect(deleted.status).toBe(200);

		expect((await userinfo(tokens.access_token)).status).toBe(401);
		for (const table of ["oauth_client", "oauth_access_token", "oauth_refresh_token"]) {
			expect(await count(table, "client_id = ?", app.clientId)).toBe(0);
		}
		expect(await count("oauth_consent", "client_id = ?", app.clientId)).toBe(0);
		expect((await userinfo(kept.tokens.access_token)).status).toBe(200);
		expect((await details(owner, workspace)).apps.map((each) => each.clientId)).toEqual([
			other.clientId,
		]);
	});

	it("a workspace takes its apps with it, and what people hold from them", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const { tokens } = await signInToApp(app, owner);
		const elsewhere = await newWorkspace(owner, "Elsewhere");
		const kept = await newApp(owner, elsewhere);

		const deleted = await api("/organization/delete", {
			who: owner,
			body: { organizationId: workspace.id },
		});
		expect(deleted.status).toBe(200);

		expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(0);
		for (const table of ["oauth_access_token", "oauth_refresh_token", "oauth_consent"]) {
			expect(await count(table, "client_id = ?", app.clientId)).toBe(0);
		}
		expect((await userinfo(tokens.access_token)).status).toBe(401);
		expect(await appRowIn(kept.clientId)).toBeTruthy();
	});
});

describe("who is sent to a workspace's app", () => {
	const NOBODY: Who = { cookie: "", client: "" };

	// Each of these has the provider send people back to the app, with an error, before it looks at who
	// they are. For anyone who could add an app, that would make a link to this server a link to anywhere.
	const WRONG: [string, Record<string, string>][] = [
		["no PKCE", { code_challenge: "", code_challenge_method: "" }],
		["half of PKCE", { code_challenge_method: "" }],
		["a method of PKCE nobody has", { code_challenge_method: "plain" }],
		["a scope nobody has", { scope: "openid nonsense" }],
		["a request object", { request: "x" }],
		["a request_uri", { request_uri: "urn:x" }],
		["a response type nobody has", { response_type: "token" }],
	];

	async function theApp() {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		return { owner, workspace, app: await newApp(owner, workspace) };
	}

	function follow(authorized: Authorized, person: Who) {
		return id
			.fetch(authorized.location, {
				headers: { "cf-connecting-ip": newClient(), cookie: person.cookie },
			})
			.then(whereAnswered);
	}

	it.each(WRONG)("keeps someone signed out here, for a request with %s", async (_name, params) => {
		const { app } = await theApp();
		const sent = await authorize(app, NOBODY, params);
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.pathname).toBe("/login");
	});

	it.each(WRONG)("keeps someone outside here, for a request with %s", async (_name, params) => {
		const { app } = await theApp();
		const sent = await authorize(app, await newPerson(), params);
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.pathname).toBe("/no-access");
	});

	it.each(WRONG)("tells the app about a member's request with %s", async (_name, params) => {
		const { app, owner } = await theApp();
		const sent = await authorize(app, owner, params);
		expect(sent.location.host).toBe(app.host);
		// A response type nobody has is answered in the fragment, as that type would have been.
		const answer = params.response_type
			? new URLSearchParams(sent.location.hash.slice(1))
			: sent.location.searchParams;
		expect(answer.get("error")).toBeTruthy();
		expect(sent.location.searchParams.has("code")).toBe(false);
	});

	// A browser's navigation is redirected, and a page's own request told where to go, as above.
	it.each(WRONG)("keeps a browser here as well, for a request with %s", async (_name, params) => {
		const { app, owner } = await theApp();
		const navigate = (who: Who) =>
			id.navigate(
				`${as.authorization_endpoint}?${new URLSearchParams({
					client_id: app.clientId,
					redirect_uri: app.redirectUri,
					response_type: "code",
					scope: SCOPE,
					code_challenge: "x".repeat(43),
					code_challenge_method: "S256",
					...params,
				})}`,
				{ "cf-connecting-ip": newClient(), cookie: who.cookie },
			);

		const signedOut = await navigate(NOBODY);
		expect(signedOut.status).toBe(302);
		expect(signedOut.location).toBe("/login");

		const stranger = await navigate(await newPerson());
		expect(stranger.status).toBe(302);
		expect(stranger.location).toBe("/no-access");

		const member = await navigate(owner);
		expect(member.status).toBe(302);
		expect(new URL(member.location ?? "", origin).host).toBe(app.host);
	});

	// The provider goes through the authorization endpoint itself once someone has signed in, with what
	// they typed still the body of the request.
	it("takes nothing anyone typed along, when they sign in on the way", async () => {
		const { app, owner } = await theApp();
		const asked = await authorize(app, NOBODY);
		expect(asked.location.pathname).toBe("/login");

		const entered = await api("/sign-in/email", {
			body: { email: owner.email, password: PASSWORD, oauth_query: asked.location.search.slice(1) },
		});
		expect(entered.status).toBe(200);
		expect(entered.headers.get("location")).toBeNull();
		expect(await entered.clone().text()).not.toContain(PASSWORD);
		const onward = await whereAnswered(entered);
		expect(onward.pathname).toBe("/consent");
		expect(onward.searchParams.has("password")).toBe(false);
		expect(onward.searchParams.has("email")).toBe(false);
		expect(onward.searchParams.get("client_id")).toBe(app.clientId);
	});

	describe("asked with POST, which OpenID Connect allows", () => {
		function posted(app: App, who: Who, params: Record<string, string> = {}) {
			return id
				.fetch(as.authorization_endpoint ?? "", {
					method: "POST",
					redirect: "manual",
					headers: {
						"cf-connecting-ip": newClient(),
						"content-type": "application/x-www-form-urlencoded",
						origin,
						cookie: who.cookie,
					},
					body: new URLSearchParams({
						client_id: app.clientId,
						redirect_uri: app.redirectUri,
						response_type: "code",
						scope: "openid",
						code_challenge: "x".repeat(43),
						code_challenge_method: "S256",
						...params,
					}),
				})
				.then(whereAnswered);
		}

		// What changes a request here goes by its address. The router answers no other spelling of it, and
		// the one the framework tidies up comes back to the address itself.
		it.each([
			["/api/auth/oauth2/authorize/", 404],
			["/api/auth//oauth2/authorize", 404],
			["//api/auth/oauth2/authorize", 308],
		])("does not answer at %s", async (path, status) => {
			const { app, owner } = await theApp();
			const claims = JSON.stringify({ userinfo: { email: null } });
			const asked = new URLSearchParams({ client_id: app.clientId, claims });
			const got = await id.fetch(`${origin}${path}?${asked}`, {
				redirect: "manual",
				headers: { "cf-connecting-ip": newClient(), cookie: owner.cookie },
			});
			const sent = await id.fetch(`${origin}${path}`, {
				method: "POST",
				redirect: "manual",
				headers: {
					"cf-connecting-ip": newClient(),
					"content-type": "application/x-www-form-urlencoded",
					origin,
					cookie: owner.cookie,
				},
				body: asked,
			});
			for (const answer of [got, sent]) {
				expect(answer.status).toBe(status);
				if (status === 308) {
					const tidied = new URL(answer.headers.get("location") ?? "", origin);
					expect(tidied.origin).toBe(origin);
					expect(tidied.pathname).toBe("/api/auth/oauth2/authorize");
				}
			}
		});

		function onward(location: URL, who: Who) {
			return id
				.fetch(location, { headers: { "cf-connecting-ip": newClient(), cookie: who.cookie } })
				.then(whereAnswered);
		}

		it("is the same request as GET, so what is checked there is checked for it", async () => {
			const { app } = await theApp();
			const sent = await posted(app, NOBODY, { state: "kept" });
			expect(sent.origin).toBe(origin);
			expect(sent.pathname).toBe("/api/auth/oauth2/authorize");
			expect(sent.searchParams.get("client_id")).toBe(app.clientId);
			expect(sent.searchParams.get("state")).toBe("kept");
			const next = await onward(sent, NOBODY);
			expect(next.pathname).toBe("/login");
			expect(next.searchParams.has("sig")).toBe(true);
		});

		it("sends nobody outside to the app", async () => {
			const { app } = await theApp();
			const stranger = await newPerson();
			for (const who of [NOBODY, stranger]) {
				const sent = await posted(app, who, { code_challenge_method: "plain" });
				const next = await onward(sent, who);
				expect(next.origin).toBe(origin);
				expect(next.pathname).toBe(who === NOBODY ? "/login" : "/no-access");
			}
		});

		it("gets an app no claims it named", async () => {
			const { app, owner } = await theApp();
			const claims = JSON.stringify({ userinfo: { email: null } });
			const sent = await posted(app, owner, { claims });
			const dropped = await onward(sent, owner);
			expect(dropped.pathname).toBe("/api/auth/oauth2/authorize");
			expect(dropped.searchParams.has("claims")).toBe(false);
			const asked = await onward(dropped, owner);
			expect(asked.pathname).toBe("/consent");
			expect(asked.searchParams.has("claims")).toBe(false);
		});
	});

	it("sends someone signed out to sign in like anyone else, when the request is right", async () => {
		const { app } = await theApp();
		const sent = await authorize(app, NOBODY);
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.pathname).toBe("/login");
		expect(sent.location.searchParams.has("sig")).toBe(true);
	});

	it("asks someone signed out to sign in, when an app asks quietly", async () => {
		const { app } = await theApp();
		const sent = await authorize(app, NOBODY, { prompt: "none" });
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.pathname).toBe("/api/auth/oauth2/authorize");
		expect(sent.location.searchParams.has("prompt")).toBe(false);
		expect(sent.location.searchParams.get("client_id")).toBe(app.clientId);

		const next = await follow(sent, NOBODY);
		expect(next.origin).toBe(origin);
		expect(next.pathname).toBe("/login");
		expect(next.searchParams.has("sig")).toBe(true);
	});

	it("keeps someone outside here, when an app asks quietly", async () => {
		const { app } = await theApp();
		const sent = await authorize(app, await newPerson(), { prompt: "none" });
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.pathname).toBe("/no-access");
	});

	it("answers a member when an app asks quietly", async () => {
		const { app, owner } = await theApp();
		const before = await authorize(app, owner, { prompt: "none" });
		expect(before.location.host).toBe(app.host);
		expect(before.location.searchParams.get("error")).toBe("consent_required");

		await signInToApp(app, owner);
		const after = await authorize(app, owner, { prompt: "none" });
		expect(after.location.host).toBe(app.host);
		expect(after.location.searchParams.has("code")).toBe(true);
	});

	it("leaves an app everyone can use as it was", async () => {
		const firstParty = await firstPartyApp();
		const app = { clientId: firstParty.clientId, redirectUri: firstParty.row.redirect_uris };
		const uri = (JSON.parse(app.redirectUri) as string[])[0] ?? "";
		const wrong = await authorize({ ...app, redirectUri: uri }, NOBODY, WRONG[0]?.[1]);
		expect(wrong.location.host).toBe(new URL(uri).host);
		const quietly = await authorize({ ...app, redirectUri: uri }, NOBODY, { prompt: "none" });
		expect(quietly.location.host).toBe(new URL(uri).host);
		expect(quietly.location.searchParams.get("error")).toBe("login_required");
	});

	it.each([
		[
			"naming it twice",
			(app: App) =>
				`/oauth2/authorize?client_id=${app.clientId}&client_id=${app.clientId}&redirect_uri=${encodeURIComponent(app.redirectUri)}&response_type=code&scope=openid`,
		],
		[
			"a slash after the path",
			(app: App) =>
				`/oauth2/authorize/?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(app.redirectUri)}&response_type=code&scope=openid`,
		],
		[
			"a second slash in the path",
			(app: App) =>
				`//oauth2/authorize?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(app.redirectUri)}&response_type=code&scope=openid`,
		],
	])("sends nobody there by %s", async (_name, path) => {
		const { app } = await theApp();
		for (const who of [NOBODY, await newPerson()]) {
			const response = await id.fetch(`${origin}/api/auth${path(app)}`, {
				headers: { "cf-connecting-ip": newClient(), cookie: who.cookie },
			});
			const where = response.headers.get("location") ?? "";
			expect(where.startsWith(app.redirectUri)).toBe(false);
			expect(await response.text()).not.toContain(`${app.redirectUri}?`);
		}
	});

	it.each([
		["/oauth2/consent", { accept: true }],
		["/oauth2/consent", { accept: false }],
		["/oauth2/continue", { postLogin: true }],
		["/oauth2/continue", { selected: true }],
		["/oauth2/continue", { created: true }],
	] as const)("sends someone else nowhere with a member's link: %s %j", async (path, body) => {
		const { app, owner } = await theApp();
		const link = await authorize(app, owner);
		expect(link.location.pathname).toBe("/consent");
		const stranger = await newPerson();
		const response = await api(path, {
			who: stranger,
			body: { ...body, oauth_query: link.location.search.slice(1) },
		});
		expect(await response.json()).toEqual({ redirect: true, url: "/no-access" });
		expect(await count("oauth_consent", "user_id = ?", stranger.userId)).toBe(0);
	});

	it("ignores claims however the request names them, and for an app everyone can use", async () => {
		const { app } = await theApp();
		const claims = JSON.stringify({ userinfo: { email: null } });
		const firstParty = await firstPartyApp();
		const uri = (JSON.parse(firstParty.row.redirect_uris) as string[])[0] ?? "";

		const everyone = await authorize({ clientId: firstParty.clientId, redirectUri: uri }, NOBODY, {
			claims,
		});
		expect(everyone.location.pathname).toBe("/api/auth/oauth2/authorize");
		expect(everyone.location.searchParams.has("claims")).toBe(false);
		expect(everyone.location.searchParams.get("client_id")).toBe(firstParty.clientId);

		// Naming the app twice leaves no one app to look up, and none is needed.
		const twice = new URLSearchParams({ client_id: app.clientId, claims });
		twice.append("client_id", app.clientId);
		const named = await id.fetch(`${as.authorization_endpoint}?${twice}`, {
			headers: { "cf-connecting-ip": newClient() },
		});
		const dropped = await whereAnswered(named);
		expect(dropped.pathname).toBe("/api/auth/oauth2/authorize");
		expect(dropped.searchParams.has("claims")).toBe(false);
		expect(dropped.searchParams.getAll("client_id")).toEqual([app.clientId, app.clientId]);
	});

	it("gives an app only what people are asked about, whatever it names", async () => {
		const { app, owner } = await theApp();
		const claims = JSON.stringify({
			userinfo: { email: null, name: null, picture: null },
			id_token: { email: null, name: null },
		});
		const sent = await authorize(app, owner, { scope: "openid", claims });
		expect(sent.location.origin).toBe(origin);
		expect(sent.location.searchParams.has("claims")).toBe(false);
		expect(sent.location.searchParams.get("scope")).toBe("openid");

		const asked = { ...sent, location: await follow(sent, owner) };
		const { tokens, claims: said } = await exchange(app, await agree(asked, owner));
		expect(said.email).toBeUndefined();
		expect(said.name).toBeUndefined();
		const told = (await (await userinfo(tokens.access_token)).json()) as object;
		expect(Object.keys(told)).toEqual(["sub"]);
	});

	it("says which app asked to give up a token, and not which one it named", async () => {
		const { app, owner, workspace } = await theApp();
		const other = await newApp(owner, workspace);
		const { tokens } = await signInToApp(app, owner);
		const asked = await id.fetch(`${origin}/api/auth/oauth2/revoke`, {
			method: "POST",
			headers: {
				"cf-connecting-ip": newClient(),
				authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ client_id: other.clientId, token: tokens.refresh_token ?? "" }),
		});
		expect(asked.status).toBe(200);
		const named = (clientId: string) =>
			count("audit_event", "type = ? AND app = ?", "token_revoked", clientId);
		await vi.waitFor(async () => expect(await named(app.clientId)).toBe(1));
		expect(await named(other.clientId)).toBe(0);
	});
});

describe("the page that asks", () => {
	function consentPage(app: App, who: Who) {
		return id
			.fetch(
				`${origin}/consent?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(
					"https://not-the-app.apps.test/callback",
				)}&scope=openid`,
				{ headers: { "cf-connecting-ip": newClient(), cookie: who.cookie, accept: "text/html" } },
			)
			.then((response) => response.text());
	}

	it("says what the app is called, whose it is and where it goes, whatever the link says", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner, "The Sprocket Guild");
		const app = await newApp(owner, workspace, "Sprocket Mirror");
		const html = await consentPage(app, owner);
		expect(html).toContain("Sprocket Mirror");
		// Words on the page, as the name alone would be there in what the page hands to the browser.
		expect(html).toContain("added this app");
		expect(html).toContain("The Sprocket Guild");
		expect(html).toContain(app.host);
		expect(html).not.toContain("not-the-app.apps.test");
	});

	it("tells someone outside nothing about it", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner, "The Hidden Guild");
		const app = await newApp(owner, workspace, "Hidden Mirror");
		const html = await consentPage(app, await newPerson());
		expect(html).not.toContain("Hidden Mirror");
		expect(html).not.toContain("The Hidden Guild");
		expect(html).not.toContain(app.host);
	});

	it("gives someone outside nothing to answer", async () => {
		const owner = await newPerson();
		const app = await newApp(owner, await newWorkspace(owner));
		const stranger = await newPerson();
		const response = await id.fetch(`${origin}/consent?client_id=${app.clientId}&scope=openid`, {
			redirect: "manual",
			headers: { "cf-connecting-ip": newClient(), cookie: stranger.cookie, accept: "text/html" },
		});
		expect(response.status).toBe(307);
		expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/no-access");
	});

	it("offers no way there from the page that refuses, unless everyone can use the app", async () => {
		const owner = await newPerson();
		const app = await newApp(owner, await newWorkspace(owner));
		const person = await newPerson();
		const refused = (clientId: string, host: string) =>
			id
				.fetch(
					`${origin}/no-access?client_id=${clientId}&sig=x&redirect_uri=${encodeURIComponent(`https://${host}/callback`)}`,
					{
						headers: {
							"cf-connecting-ip": newClient(),
							cookie: person.cookie,
							accept: "text/html",
						},
					},
				)
				.then((response) => response.text());
		expect(await refused(app.clientId, app.host)).not.toContain("Back to");

		const firstParty = await firstPartyApp();
		expect(await refused(firstParty.clientId, "first-party.apps.test")).toContain("Back to");
	});
});

describe("an app giving up a token", () => {
	it("says whose app it was in the log", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const { tokens } = await signInToApp(app, owner);
		const revoked = await oauth.revocationRequest(
			as,
			app.client,
			app.auth,
			tokens.refresh_token ?? "",
			fromApp,
		);
		expect(revoked.status).toBe(200);
		await vi.waitFor(
			async () => {
				expect(
					await count(
						"audit_event",
						"type = 'token_revoked' AND app = ? AND workspace_id = ?",
						app.clientId,
						workspace.id,
					),
				).toBe(1);
			},
			{ timeout: 5_000 },
		);
	});
});

describe("someone's own activity", () => {
	async function activity(who: Who) {
		const response = await api("/account/activity", { who });
		expect(response.status).toBe(200);
		return ((await response.json()) as { events: { type: string; app: string | null }[] }).events;
	}

	it("calls an app by its name, for a member", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace, "Named Mirror");
		await signInToApp(app, owner);
		await id.auditEventRecorded(owner.userId, { type: "app_sign_in", app: app.clientId });
		const events = await activity(owner);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "app_sign_in", app: "Named Mirror" }),
		);
		expect(JSON.stringify(events)).not.toContain(app.clientId);
	});

	it("does not name an app to someone it turned away, who has only its id", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace, "Unnamed Mirror");
		const stranger = await newPerson();
		const refused = await authorize(app, stranger);
		await api("/oauth2/consent", {
			who: stranger,
			body: { accept: true, oauth_query: refused.location.search.slice(1) },
		});
		await id.auditEventRecorded(stranger.userId, { type: "refused", app: app.clientId });
		const events = await activity(stranger);
		expect(events).toContainEqual(expect.objectContaining({ type: "refused", app: null }));
		expect(JSON.stringify(events)).not.toContain("Unnamed Mirror");
		expect(JSON.stringify(events)).not.toContain(app.clientId);
	});

	it("still calls an app everyone can use by its id when it has gone", async () => {
		const person = await newPerson();
		await id.db
			.prepare("INSERT INTO audit_event (id, at, type, user_id, app) VALUES (?, ?, ?, ?, ?)")
			.bind(crypto.randomUUID(), Date.now(), "app_sign_in", person.userId, "retired-product")
			.run();
		expect(await activity(person)).toContainEqual(
			expect.objectContaining({ type: "app_sign_in", app: "retired-product" }),
		);
	});

	it("says what it can of an app deleted since, and nothing of its id", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace, "Gone Mirror");
		await signInToApp(app, owner);
		await id.auditEventRecorded(owner.userId, { type: "app_sign_in", app: app.clientId });
		await api("/workspaces/apps/delete", {
			who: owner,
			body: { organizationId: workspace.id, clientId: app.clientId },
		});
		await id.auditEventRecorded(owner.userId, { type: "app_deleted", app: app.clientId });
		const events = await activity(owner);
		expect(events).toContainEqual(expect.objectContaining({ type: "app_sign_in", app: null }));
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "app_deleted",
				detail: JSON.stringify({ workspace: workspace.name, name: "Gone Mirror" }),
			}),
		);
	});
});

describe("a deployment with no provider", () => {
	it("offers no apps, to add or to see", async () => {
		const plain = await startId(origin, { oidc: false });
		try {
			const email = "no-provider@example.com";
			const post = (path: string, body: object, cookie?: string) =>
				plain.fetch(`${origin}/api/auth${path}`, {
					method: "POST",
					headers: {
						origin,
						"cf-connecting-ip": newClient(),
						"content-type": "application/json",
						...(cookie && { cookie }),
					},
					body: JSON.stringify(body),
				});
			await post("/email-otp/send-verification-otp", { email, type: "sign-in" });
			const otp = await vi.waitFor(
				async () => {
					const sent = (await plain.emails()).find((message) => message.to === email);
					const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
					if (!code) throw new Error("No code yet");
					return code;
				},
				{ timeout: 5_000 },
			);
			const entered = await post("/sign-in/email-otp", { email, otp, name: "Ada" });
			const cookie = cookieOf(entered);
			await post("/account/first-password", { newPassword: PASSWORD }, cookie);
			const made = await post("/organization/create", { name: "Acme", slug: "acme" }, cookie);
			const { id: organizationId } = (await made.json()) as { id: string };

			const added = await post(
				"/workspaces/apps/add",
				{ organizationId, name: "Tool", redirectUris: ["https://tool.apps.test/callback"] },
				cookie,
			);
			expect(added.status).toBe(404);

			const seen = await plain.fetch(`${origin}/api/auth/workspaces/get?slug=acme`, {
				headers: { origin, "cf-connecting-ip": newClient(), cookie },
			});
			expect(await seen.json()).toMatchObject({ apps: [], appsEnabled: false });
		} finally {
			await plain.dispose();
		}
	});
});
