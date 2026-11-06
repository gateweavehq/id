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
		apps: {
			clientId: string;
			name: string;
			redirectUris: string[];
			groups: string[];
			clientAuth: string;
			requirePkce: boolean;
			addedAt: number | null;
			addedBy: { name: string | null; stillMember: boolean } | null;
		}[];
		groups: { id: string; name: string; members: string[] }[];
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

async function newApp(
	owner: Who,
	workspace: Workspace,
	name = `Tool ${hosts + 1}`,
	library: { clientAuth?: string; requirePkce?: boolean } = {},
) {
	const host = `tool-${++hosts}.apps.test`;
	const redirectUri = `https://${host}/callback`;
	const response = await api("/workspaces/apps/add", {
		who: owner,
		body: { organizationId: workspace.id, name, redirectUris: [redirectUri], ...library },
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
	leavingOut: string[] = [],
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
	for (const name of leavingOut) url.searchParams.delete(name);
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

/** An app that sent no challenge or no nonce says so, in place of the value it would check. */
type Exchanging = Omit<Authorized, "verifier" | "nonce"> & {
	verifier: string | typeof oauth.nopkce;
	nonce: string | typeof oauth.expectNoNonce;
};

async function exchange(app: App, authorized: Exchanging) {
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

function heldBy(person: Pick<Person, "userId">, app: Pick<App, "clientId">) {
	return Promise.all(
		["oauth_access_token", "oauth_refresh_token", "oauth_consent"].map((table) =>
			count(table, "user_id = ? AND client_id = ?", person.userId, app.clientId),
		),
	);
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
			{
				clientId: app.clientId,
				name: app.name,
				redirectUris: [app.redirectUri],
				groups: [],
				clientAuth: "client_secret_basic",
				requirePkce: true,
				addedAt: expect.any(Number),
				addedBy: { name: "Ada", stillMember: true },
			},
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
				addedBy: owner.userId,
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
				clientAuth: "client_secret_basic",
				requirePkce: true,
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
				clientAuth: "client_secret_basic",
				requirePkce: true,
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

describe("who added an app", () => {
	it("is shown with it, outlasts what changes it, and is flagged once they have left", async () => {
		const owner = await newPerson("Ada");
		const workspace = await newWorkspace(owner);
		const grace = await newPerson("Grace");
		const graceMember = await join(grace, workspace, owner, "admin");
		const before = Date.now();
		const app = await newApp(grace, workspace);
		const listed = async () =>
			(await details(owner, workspace)).apps.find(({ clientId }) => clientId === app.clientId);

		const added = await listed();
		expect(added?.addedBy).toEqual({ name: "Grace", stillMember: true });
		expect(added?.addedAt).toBeGreaterThanOrEqual(before);

		// The app's own changes, and the provider signing someone in to it, leave the column alone.
		const which = { organizationId: workspace.id, clientId: app.clientId };
		const changed = await api("/workspaces/apps/change", {
			who: owner,
			body: { ...which, name: "Renamed", redirectUris: [app.redirectUri] },
		});
		expect(changed.status).toBe(200);
		expect((await api("/workspaces/apps/replace-secret", { who: owner, body: which })).status).toBe(
			200,
		);
		expect((await appRowIn(app.clientId))?.added_by).toBe(grace.userId);

		await remove(owner, workspace, graceMember);
		expect((await listed())?.addedBy).toEqual({ name: "Grace", stillMember: false });
	});

	it("is left out for an app added before ID kept it", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		await id.db
			.prepare("UPDATE oauth_client SET added_by = NULL WHERE client_id = ?")
			.bind(app.clientId)
			.run();
		const listed = (await details(owner, workspace)).apps.find(
			({ clientId }) => clientId === app.clientId,
		);
		expect(listed?.addedBy).toBeNull();
		expect(listed?.addedAt).not.toBeNull();
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
			{
				clientId: app.clientId,
				name: "Renamed",
				redirectUris: [moved],
				groups: [],
				clientAuth: "client_secret_basic",
				requirePkce: true,
				addedAt: expect.any(Number),
				addedBy: { name: "Ada", stillMember: true },
			},
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

describe("an app whose library needs something else", () => {
	const NO_PKCE = ["code_challenge", "code_challenge_method"];

	async function anApp(library: { clientAuth?: string; requirePkce?: boolean } = {}) {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace, undefined, library);
		const which = { organizationId: workspace.id, clientId: app.clientId };
		return {
			owner,
			workspace,
			app,
			change: { ...which, name: app.name, redirectUris: [app.redirectUri] },
			inTheBody: { ...app, auth: oauth.ClientSecretPost(app.clientSecret) },
		};
	}

	/** What the app's server hears when it is not let in, which says why. */
	function refusal(exchanging: Promise<unknown>, why: object) {
		return expect(exchanging).rejects.toMatchObject(why);
	}

	// RFC 6749, 5.2: a client that tried HTTP Basic is told 401 and challenged, and one that did not gets 400.
	const BASIC_REFUSED = { status: 401 };
	const BODY_REFUSED = { status: 400, error: "invalid_client" };

	function errorAtTheApp(authorized: Authorized, app: App) {
		expect(authorized.location.host).toBe(app.host);
		expect(authorized.location.searchParams.has("code")).toBe(false);
		return authorized.location.searchParams.get("error");
	}

	describe("sending its secret another way", () => {
		it("signs in and refreshes that way", async () => {
			const { owner, inTheBody } = await anApp({ clientAuth: "client_secret_post" });
			const { tokens } = await signInToApp(inTheBody, owner);
			const refreshed = await refresh(inTheBody, tokens.refresh_token);
			expect(refreshed.access_token).toBeTruthy();
			expect(await appRowIn(inTheBody.clientId)).toMatchObject({
				token_endpoint_auth_method: "client_secret_post",
				require_pkce: 1,
			});
		});

		it("takes only the way it was registered for", async () => {
			const { owner, app } = await anApp({ clientAuth: "client_secret_post" });
			await refusal(signInToApp(app, owner), BASIC_REFUSED);
		});

		it("takes only HTTP Basic from an app that did not say otherwise", async () => {
			const { owner, inTheBody } = await anApp();
			await refusal(signInToApp(inTheBody, owner), BODY_REFUSED);
		});

		it.each([["none"], ["private_key_jwt"], ["client_secret_jwt"], ["tls_client_auth"]])(
			"cannot be %s",
			async (clientAuth) => {
				const { owner, workspace, app, change } = await anApp();
				const before = await appRowIn(app.clientId);
				const added = await api("/workspaces/apps/add", {
					who: owner,
					body: {
						organizationId: workspace.id,
						name: "Other",
						redirectUris: ["https://other.apps.test/callback"],
						clientAuth,
					},
				});
				expect(added.status).toBe(400);
				const changed = await api("/workspaces/apps/change", {
					who: owner,
					body: { ...change, clientAuth },
				});
				expect(changed.status).toBe(400);
				expect(await appRowIn(app.clientId)).toEqual(before);
				expect(await count("oauth_client", "reference_id = ?", workspace.id)).toBe(1);
			},
		);
	});

	describe("leaving PKCE out", () => {
		it("signs in with a nonce", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const asked = await agree(await authorize(app, owner, {}, NO_PKCE), owner);
			const { tokens, claims } = await exchange(app, { ...asked, verifier: oauth.nopkce });
			expect(claims.nonce).toBe(asked.nonce);
			expect(tokens.refresh_token).toBeTruthy();
			expect(await appRowIn(app.clientId)).toMatchObject({
				token_endpoint_auth_method: "client_secret_basic",
				require_pkce: 0,
			});
		});

		it("is refused for an app that did not say so, at the app", async () => {
			const { owner, app } = await anApp();
			expect(errorAtTheApp(await authorize(app, owner, {}, NO_PKCE), app)).toBe("invalid_request");
		});

		it("gets no refresh token with neither PKCE nor a nonce", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const neither = await authorize(app, owner, {}, [...NO_PKCE, "nonce"]);
			expect(errorAtTheApp(neither, app)).toBe("invalid_request");
		});

		it("leaves it to the app whether to send a nonce otherwise", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const scope = { scope: "openid email" };
			const asked = await agree(await authorize(app, owner, scope, [...NO_PKCE, "nonce"]), owner);
			const { claims } = await exchange(app, {
				...asked,
				verifier: oauth.nopkce,
				nonce: oauth.expectNoNonce,
			});
			expect(claims.nonce).toBeUndefined();
		});

		it("takes no verifier for a code that was asked for with no challenge", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const asked = await agree(await authorize(app, owner, {}, NO_PKCE), owner);
			await refusal(exchange(app, asked), { error: "invalid_request" });
		});

		it("holds an app to a challenge it did send", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const first = await agree(await authorize(app, owner), owner);
			await refusal(exchange(app, { ...first, verifier: oauth.nopkce }), {
				error: "invalid_request",
			});
			const second = await authorize(app, owner);
			await refusal(exchange(app, { ...second, verifier: oauth.generateRandomCodeVerifier() }), {
				error: "invalid_grant",
			});
			const { tokens } = await exchange(app, await authorize(app, owner));
			expect(tokens.access_token).toBeTruthy();
		});

		it("still asks people, and still keeps out anyone who is not a member", async () => {
			const { owner, app } = await anApp({ requirePkce: false });
			const stranger = await newPerson();
			expectRefused(await authorize(app, stranger, {}, NO_PKCE), app);
			const asked = await authorize(app, owner, {}, NO_PKCE);
			expect(asked.location.pathname).toBe("/consent");
		});
	});

	describe("changing them", () => {
		it("takes effect at the next sign-in, and shows", async () => {
			const { owner, workspace, app, change, inTheBody } = await anApp();
			const changed = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, clientAuth: "client_secret_post", requirePkce: false },
			});
			expect(changed.status).toBe(200);
			expect((await details(owner, workspace)).apps[0]).toMatchObject({
				clientAuth: "client_secret_post",
				requirePkce: false,
			});
			const asked = await agree(await authorize(app, owner, {}, NO_PKCE), owner);
			const { claims } = await exchange(inTheBody, { ...asked, verifier: oauth.nopkce });
			expect(claims.sub).toBeTruthy();
			await id.auditEventRecorded(owner.userId, {
				type: "app_changed",
				app: app.clientId,
				detail: JSON.stringify({
					workspace: workspace.name,
					name: app.name,
					redirectUris: [app.redirectUri],
					clientAuth: "client_secret_post",
					requirePkce: false,
				}),
			});

			const back = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, clientAuth: "client_secret_basic", requirePkce: true },
			});
			expect(back.status).toBe(200);
			expect(errorAtTheApp(await authorize(app, owner, {}, NO_PKCE), app)).toBe("invalid_request");
			await refusal(exchange(inTheBody, await authorize(app, owner)), BODY_REFUSED);
		});

		it("leaves them as they are when a change does not mention them", async () => {
			const { owner, workspace, change } = await anApp({
				clientAuth: "client_secret_post",
				requirePkce: false,
			});
			const renamed = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, name: "Renamed" },
			});
			expect(renamed.status).toBe(200);
			expect((await details(owner, workspace)).apps[0]).toMatchObject({
				name: "Renamed",
				clientAuth: "client_secret_post",
				requirePkce: false,
			});
		});

		it("wants someone who signed in recently to turn PKCE off", async () => {
			const { owner, app, change } = await anApp();
			const before = await appRowIn(app.clientId);
			await ageSession(owner);
			const refused = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, name: "Renamed", clientAuth: "client_secret_post", requirePkce: false },
			});
			expect(refused.status).toBe(403);
			expect(((await refused.json()) as { code: string }).code).toBe("SESSION_NOT_FRESH");
			expect(await appRowIn(app.clientId)).toEqual(before);
		});

		it("does not ask that for anything else", async () => {
			const { owner, app, change } = await anApp();
			await ageSession(owner);
			const other = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, requirePkce: true, clientAuth: "client_secret_post" },
			});
			expect(other.status).toBe(200);
			expect(await appRowIn(app.clientId)).toMatchObject({
				token_endpoint_auth_method: "client_secret_post",
				require_pkce: 1,
			});
		});

		it("does not ask it of an app that has it off already, or to turn it on", async () => {
			const { owner, app, change } = await anApp({ requirePkce: false });
			await ageSession(owner);
			const same = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, requirePkce: false },
			});
			expect(same.status).toBe(200);
			const on = await api("/workspaces/apps/change", {
				who: owner,
				body: { ...change, requirePkce: true },
			});
			expect(on.status).toBe(200);
			expect(await appRowIn(app.clientId)).toMatchObject({ require_pkce: 1 });
		});

		it("is for those who manage apps", async () => {
			const { owner, workspace, app, change } = await anApp();
			const member = await newPerson();
			await join(member, workspace, owner);
			const before = await appRowIn(app.clientId);
			const refused = await api("/workspaces/apps/change", {
				who: member,
				body: { ...change, requirePkce: false },
			});
			expect(refused.status).toBe(403);
			expect(await appRowIn(app.clientId)).toEqual(before);
		});

		it("leaves another workspace's app alone", async () => {
			const { app } = await anApp();
			const other = await anApp();
			const before = await appRowIn(app.clientId);
			const refused = await api("/workspaces/apps/change", {
				who: other.owner,
				body: { ...other.change, clientId: app.clientId, requirePkce: false },
			});
			expect(refused.status).toBe(404);
			expect(await appRowIn(app.clientId)).toEqual(before);
		});
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

describe("taking an app back", () => {
	interface Listed {
		clientId: string;
		name: string;
		workspace: string;
		host: string;
		scopes: string[];
		allowedAt: string;
		lastSignIn: string | null;
	}

	async function allowedApps(who: Who) {
		const response = await api("/account/allowed-apps", { who });
		expect(response.status).toBe(200);
		return ((await response.json()) as { apps: Listed[] }).apps;
	}

	function takeBack(who: Who, clientId: string) {
		return api("/account/allowed-apps/take-back", { who, body: { clientId } });
	}

	async function allowed() {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const person = await newPerson("Grace");
		const memberId = await join(person, workspace, owner);
		const { tokens } = await signInToApp(app, person);
		return { owner, workspace, app, person, memberId, tokens };
	}

	/** A first-party app does not ask unless it asks to, which is the one way to have a row for one. */
	async function firstPartyAppAllowedBy(person: Who) {
		const made = await firstPartyApp();
		const redirectUri: string = JSON.parse(made.row.redirect_uris)[0];
		const asked = await authorize({ clientId: made.clientId, redirectUri }, person, {
			prompt: "consent",
		});
		await agree(asked, person);
		return made;
	}

	let written = 0;

	/** The row a crossing with a take-back would leave, asked back as the provider's adapter asks. */
	async function writeToken(table: string, userId: string, clientId: string) {
		const rowId = `written-${++written}`;
		return id.db
			.prepare(
				`INSERT INTO ${table} (id, token, client_id, user_id, scopes, expires_at, created_at)
				VALUES (?1, ?1, ?2, ?3, '"[\\"openid\\"]"', ?4, ?4) RETURNING id`,
			)
			.bind(rowId, clientId, userId, Date.now() + 3_600_000)
			.first<{ id: string }>();
	}

	/** An access token made from a refresh token whose own row has already gone. */
	function writeAccessTokenFrom(refreshId: string, userId: string, clientId: string) {
		const rowId = `written-${++written}`;
		return id.db
			.prepare(
				`INSERT INTO oauth_access_token
				(id, token, client_id, user_id, refresh_id, scopes, expires_at, created_at)
				VALUES (?1, ?1, ?2, ?3, ?4, '"[\\"openid\\"]"', ?5, ?5) RETURNING id`,
			)
			.bind(rowId, clientId, userId, refreshId, Date.now() + 3_600_000)
			.first<{ id: string }>();
	}

	async function tokenRows(userId: string, clientId: string) {
		const counts = await Promise.all(
			["oauth_access_token", "oauth_refresh_token"].map((table) =>
				count(table, "user_id = ? AND client_id = ?", userId, clientId),
			),
		);
		return counts.reduce((sum: number, n: unknown) => sum + Number(n ?? 0), 0);
	}

	describe("the list", () => {
		it("still opens for someone who has allowed more apps than D1 takes parameters", async () => {
			const { workspace, person } = await allowed();
			const many = 120;
			// One statement each: making them through the API would take as long as the rest of the file.
			await id.db
				.prepare(
					`WITH RECURSIVE row(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM row WHERE n < ${many})
					INSERT INTO oauth_client (id, client_id, name, redirect_uris, reference_id, created_at, updated_at)
					SELECT 'many-' || n, 'many-' || n, 'Many ' || n, '["https://many.test/callback"]', ?1, ?2, ?2 FROM row`,
				)
				.bind(workspace.id, Date.now())
				.run();
			await id.db
				.prepare(
					`WITH RECURSIVE row(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM row WHERE n < ${many})
					INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
					SELECT 'many-' || n, 'many-' || n, ?1, '"[\\"openid\\"]"', ?2, ?2 FROM row`,
				)
				.bind(person.userId, Date.now())
				.run();

			const apps = await allowedApps(person);
			expect(apps).toHaveLength(many + 1);
		});

		it("says what someone allowed, whose it is and where it goes", async () => {
			const { app, person, workspace } = await allowed();
			await id.auditEventRecorded(person.userId, { type: "app_sign_in", app: app.clientId });

			const response = await api("/account/allowed-apps", { who: person });
			expect(response.headers.get("cache-control")).toContain("no-store");
			const text = await response.text();
			expect((JSON.parse(text) as { apps: Listed[] }).apps).toEqual([
				{
					clientId: app.clientId,
					name: app.name,
					workspace: workspace.name,
					host: app.host,
					scopes: SCOPE.split(" "),
					allowedAt: expect.any(String),
					lastSignIn: expect.any(String),
				},
			]);
			const row = await appRowIn(app.clientId);
			expect(text).not.toContain(String(row?.client_secret));
			expect(text).not.toContain(app.clientSecret);
		});

		it("has no last sign-in once the log has let go of it, whoever else signed in", async () => {
			const { owner, app, person } = await allowed();
			await signInToApp(app, owner);
			await id.auditEventRecorded(owner.userId, { type: "app_sign_in", app: app.clientId });
			await id.auditEventRecorded(person.userId, { type: "app_sign_in", app: app.clientId });
			await id.db
				.prepare("DELETE FROM audit_event WHERE user_id = ? AND type = 'app_sign_in'")
				.bind(person.userId)
				.run();
			expect(await allowedApps(person)).toEqual([expect.objectContaining({ lastSignIn: null })]);
		});

		it("still names an app whose scopes it cannot read", async () => {
			const { app, person } = await allowed();
			await id.db
				.prepare("UPDATE oauth_consent SET scopes = ? WHERE user_id = ? AND client_id = ?")
				.bind(JSON.stringify("not a list"), person.userId, app.clientId)
				.run();
			expect(await allowedApps(person)).toEqual([
				expect.objectContaining({ clientId: app.clientId, scopes: [] }),
			]);
		});

		it("goes by what this person did, not by anything they could reach", async () => {
			const { owner, workspace, app, person } = await allowed();
			const asked = await newPerson();
			await join(asked, workspace, owner);
			await authorize(app, asked);
			const denied = await newPerson();
			await join(denied, workspace, owner);
			const denying = await authorize(app, denied);
			await api("/oauth2/consent", {
				who: denied,
				body: { accept: false, oauth_query: denying.location.search.slice(1) },
			});
			const stranger = await newPerson();

			expect(await allowedApps(person)).toHaveLength(1);
			// Not the admin who added it, a member still being asked, one who said no, or anyone else.
			expect(await allowedApps(owner)).toEqual([]);
			expect(await allowedApps(asked)).toEqual([]);
			expect(await allowedApps(denied)).toEqual([]);
			expect(await allowedApps(stranger)).toEqual([]);
		});

		it("leaves out a first-party app, even one that asked", async () => {
			const person = await newPerson();
			const made = await firstPartyAppAllowedBy(person);
			expect(await heldBy(person, made)).toEqual([0, 0, 1]);
			expect(await allowedApps(person)).toEqual([]);
		});

		it("loses what someone allowed when they leave, or when the app goes", async () => {
			const { owner, workspace, app, person, memberId } = await allowed();
			const other = await newApp(owner, workspace);
			await signInToApp(other, person);
			expect(await allowedApps(person)).toHaveLength(2);

			const deleted = await api("/workspaces/apps/delete", {
				who: owner,
				body: { organizationId: workspace.id, clientId: other.clientId },
			});
			expect(deleted.status).toBe(200);
			expect((await allowedApps(person)).map(({ clientId }) => clientId)).toEqual([app.clientId]);

			await remove(owner, workspace, memberId);
			expect(await allowedApps(person)).toEqual([]);
			expect((await takeBack(person, app.clientId)).status).toBe(404);
		});

		it("is for someone signed in", async () => {
			expect((await api("/account/allowed-apps")).status).toBe(401);
		});
	});

	it("ends what the app holds at once, and it has to ask again", async () => {
		const { app, person, workspace, tokens } = await allowed();
		expect((await userinfo(tokens.access_token)).status).toBe(200);
		expect(await heldBy(person, app)).toEqual([expect.any(Number), 1, 1]);

		const taken = await takeBack(person, app.clientId);
		expect(taken.status).toBe(200);
		expect(taken.headers.get("cache-control")).toContain("no-store");

		expect((await userinfo(tokens.access_token)).status).toBe(401);
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		expect(await heldBy(person, app)).toEqual([0, 0, 0]);
		expect(await allowedApps(person)).toEqual([]);

		// They are still a member, and only the app has to ask.
		expect((await details(person, workspace)).you.memberId).toBeTruthy();
		const quietly = await authorize(app, person, { prompt: "none" });
		expect(quietly.location.searchParams.has("code")).toBe(false);
		expect(quietly.location.searchParams.get("error")).toBe("consent_required");

		const again = await signInToApp(app, person);
		expect((await userinfo(again.tokens.access_token)).status).toBe(200);
		expect(await allowedApps(person)).toHaveLength(1);
	});

	it("touches nobody else's, and no other app", async () => {
		const { owner, workspace, app, person, tokens } = await allowed();
		const other = await newPerson();
		await join(other, workspace, owner);
		const theirs = await signInToApp(app, other);
		const second = await newApp(owner, workspace);
		const inSecond = await signInToApp(second, person);

		expect((await takeBack(person, app.clientId)).status).toBe(200);

		expect((await userinfo(tokens.access_token)).status).toBe(401);
		expect((await userinfo(theirs.tokens.access_token)).status).toBe(200);
		expect(await heldBy(other, app)).toEqual([expect.any(Number), 1, 1]);
		expect((await refresh(app, theirs.tokens.refresh_token)).access_token).toBeTruthy();
		expect((await userinfo(inSecond.tokens.access_token)).status).toBe(200);
		expect(await heldBy(person, second)).toEqual([expect.any(Number), 1, 1]);
		expect((await allowedApps(person)).map(({ clientId }) => clientId)).toEqual([second.clientId]);
	});

	it("ends an access token that came with no refresh token to take it along", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const person = await newPerson();
		await join(person, workspace, owner);
		const asked = await authorize(app, person, { scope: "openid email" });
		const { tokens } = await exchange(app, await agree(asked, person));
		expect(tokens.refresh_token).toBeUndefined();
		expect((await userinfo(tokens.access_token)).status).toBe(200);

		expect((await takeBack(person, app.clientId)).status).toBe(200);

		expect((await userinfo(tokens.access_token)).status).toBe(401);
		expect(await heldBy(person, app)).toEqual([0, 0, 0]);
	});

	it("refuses a code the app was handed before, whatever else stands", async () => {
		const { owner, workspace, app, person } = await allowed();
		// Someone else's yes to this app, and this person's to another, are not theirs to this one.
		const other = await newPerson();
		await join(other, workspace, owner);
		await signInToApp(app, other);
		await signInToApp(await newApp(owner, workspace), person);
		const handed = await authorize(app, person);
		expect(handed.location.searchParams.has("code")).toBe(true);

		expect((await takeBack(person, app.clientId)).status).toBe(200);

		await expect(exchange(app, handed)).rejects.toMatchObject({ error: "invalid_grant" });
		expect(await heldBy(person, app)).toEqual([0, 0, 0]);
		await id.auditEventRecorded(person.userId, {
			type: "refused",
			app: app.clientId,
			detail: "authorization_code",
		});
	});

	it("refuses a refresh with no consent, however that came about", async () => {
		const { app, person, tokens } = await allowed();
		await id.db
			.prepare("DELETE FROM oauth_consent WHERE user_id = ? AND client_id = ?")
			.bind(person.userId, app.clientId)
			.run();
		await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		await id.auditEventRecorded(person.userId, {
			type: "refused",
			app: app.clientId,
			detail: "refresh_token",
		});
	});

	it("does not let an old code buy more than they say yes to again", async () => {
		const { app, person } = await allowed();
		const handed = await authorize(app, person);
		expect(handed.location.searchParams.has("code")).toBe(true);
		expect((await takeBack(person, app.clientId)).status).toBe(200);

		const again = await agree(await authorize(app, person, { scope: "openid" }), person);
		await expect(exchange(app, handed)).rejects.toMatchObject({ error: "invalid_grant" });
		expect(await heldBy(person, app)).toEqual([0, 0, 1]);
		await id.auditEventRecorded(person.userId, {
			type: "refused",
			app: app.clientId,
			detail: "authorization_code",
		});

		// What they said yes to works, and gets no more than that.
		const { tokens } = await exchange(app, again);
		const answer = await userinfo(tokens.access_token);
		expect(answer.status).toBe(200);
		const seen = (await answer.json()) as { email?: string };
		expect(seen.email).toBeUndefined();
	});

	it("refuses tokens when it cannot read what they allowed", async () => {
		const { app, person } = await allowed();
		const handed = await authorize(app, person);
		await id.db
			.prepare("UPDATE oauth_consent SET scopes = ? WHERE user_id = ? AND client_id = ?")
			.bind(JSON.stringify("not a list"), person.userId, app.clientId)
			.run();
		await expect(exchange(app, handed)).rejects.toMatchObject({ error: "invalid_grant" });
	});

	it("lets an old code buy what they say yes to again, and no less", async () => {
		const { app, person } = await allowed();
		const handed = await authorize(app, person);
		expect((await takeBack(person, app.clientId)).status).toBe(200);
		await signInToApp(app, person);

		const { tokens } = await exchange(app, handed);
		expect((await userinfo(tokens.access_token)).status).toBe(200);
	});

	describe("a yes that changes", () => {
		it("ends what came of the old one, so the list is what the app holds", async () => {
			const { app, person, tokens } = await allowed();
			const asked = await authorize(app, person, { scope: "openid", prompt: "consent" });
			const narrower = await agree(asked, person);

			expect((await userinfo(tokens.access_token)).status).toBe(401);
			await expect(refresh(app, tokens.refresh_token)).rejects.toMatchObject({
				error: "invalid_grant",
			});
			expect(await heldBy(person, app)).toEqual([0, 0, 1]);
			const [listed] = await allowedApps(person);
			expect(listed?.scopes).toEqual(["openid"]);

			const { tokens: fresh } = await exchange(app, narrower);
			expect((await userinfo(fresh.access_token)).status).toBe(200);
		});

		it("ends an access token with no refresh token behind it", async () => {
			const { owner, workspace } = await allowed();
			const app = await newApp(owner, workspace);
			const person = await newPerson();
			await join(person, workspace, owner);
			const { tokens } = await exchange(
				app,
				await agree(await authorize(app, person, { scope: "openid email" }), person),
			);
			expect(tokens.refresh_token).toBeUndefined();
			expect(await heldBy(person, app)).toEqual([1, 0, 1]);

			await agree(await authorize(app, person, { scope: "openid", prompt: "consent" }), person);
			expect((await userinfo(tokens.access_token)).status).toBe(401);
			expect(await heldBy(person, app)).toEqual([0, 0, 1]);
		});

		it("happens when an app asks for more, without asking to ask again", async () => {
			const { app, person, tokens } = await allowed();
			const less = await agree(
				await authorize(app, person, { scope: "openid", prompt: "consent" }),
				person,
			);
			const { tokens: fewer } = await exchange(app, less);
			expect(tokens.access_token).not.toBe(fewer.access_token);

			const more = await agree(await authorize(app, person), person);
			expect((await userinfo(fewer.access_token)).status).toBe(401);
			expect(await heldBy(person, app)).toEqual([0, 0, 1]);

			const { tokens: fresh } = await exchange(app, more);
			expect((await userinfo(fresh.access_token)).status).toBe(200);
			await expect(refresh(app, fresh.refresh_token)).resolves.toMatchObject({
				token_type: expect.any(String),
			});
		});

		it("replaces the old list, so what is left out is gone", async () => {
			const { app, person } = await allowed();
			const asked = await authorize(app, person, { scope: "openid profile", prompt: "consent" });
			const { tokens } = await exchange(app, await agree(asked, person));
			expect(tokens.refresh_token).toBeUndefined();
			const [listed] = await allowedApps(person);
			expect(listed?.scopes).toEqual(["openid", "profile"]);
		});

		it("counts the same scopes in another order as a change", async () => {
			const { app, person, tokens } = await allowed();
			const reversed = SCOPE.split(" ").reverse().join(" ");
			await agree(await authorize(app, person, { scope: reversed, prompt: "consent" }), person);
			expect((await userinfo(tokens.access_token)).status).toBe(401);
		});

		it("leaves what they hold when it is the same yes", async () => {
			const { app, person, tokens } = await allowed();
			await agree(await authorize(app, person, { prompt: "consent" }), person);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(person, app)).toEqual([1, 1, 1]);
		});

		it("leaves other people's tokens and other apps' alone", async () => {
			const { owner, workspace, app, person, tokens } = await allowed();
			const other = await newPerson();
			await join(other, workspace, owner);
			const theirs = await signInToApp(app, other);
			const secondApp = await newApp(owner, workspace);
			const second = await signInToApp(secondApp, person);

			await agree(await authorize(app, person, { scope: "openid", prompt: "consent" }), person);

			expect((await userinfo(tokens.access_token)).status).toBe(401);
			expect((await userinfo(theirs.tokens.access_token)).status).toBe(200);
			expect((await userinfo(second.tokens.access_token)).status).toBe(200);
			expect(await heldBy(other, app)).toEqual([1, 1, 1]);
			expect(await heldBy(person, secondApp)).toEqual([1, 1, 1]);
		});

		it("does not touch a first-party app's tokens", async () => {
			const person = await newPerson();
			const made = await firstPartyAppAllowedBy(person);
			const redirectUri: string = JSON.parse(made.row.redirect_uris)[0];
			const before = await tokenRows(person.userId, made.clientId);
			await writeToken("oauth_access_token", person.userId, made.clientId);
			expect(await tokenRows(person.userId, made.clientId)).toBe(before + 1);

			const asked = await authorize({ clientId: made.clientId, redirectUri }, person, {
				scope: "openid",
				prompt: "consent",
			});
			await agree(asked, person);
			expect(await tokenRows(person.userId, made.clientId)).toBe(before + 1);
		});
	});

	describe("two answers at once", () => {
		it("make one row, so the list cannot show the app twice", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const app = await newApp(owner, workspace);
			const person = await newPerson();
			await join(person, workspace, owner);
			const asked = await authorize(app, person);
			expect(asked.location.pathname).toBe("/consent");

			const answers = await Promise.all(
				[1, 2].map(() =>
					api("/oauth2/consent", {
						who: person,
						body: { accept: true, oauth_query: asked.location.search.slice(1) },
					}),
				),
			);
			expect(answers.map(({ status }) => status)).toContain(200);
			expect(
				await count("oauth_consent", "user_id = ? AND client_id = ?", person.userId, app.clientId),
			).toBe(1);
			expect(await allowedApps(person)).toHaveLength(1);
		});

		it("cannot be written as two rows, however they arrive", async () => {
			const { app, person } = await allowed();
			await expect(
				id.db
					.prepare(
						`INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
						VALUES ('second-answer', ?1, ?2, '"[\\"openid\\"]"', ?3, ?3)`,
					)
					.bind(app.clientId, person.userId, Date.now())
					.run(),
			).rejects.toThrow(/UNIQUE/i);
		});
	});

	describe("a token written after the answer changed", () => {
		// A crossing cannot be timed from outside, so these write the row the provider would be writing.
		// The statement is the adapter's in shape: it asks for the row back, and the row must still go.
		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"goes as it arrives in %s, once they have taken the app back",
			async (table) => {
				const { app, person } = await allowed();
				expect((await takeBack(person, app.clientId)).status).toBe(200);

				const written = await writeToken(table, person.userId, app.clientId);
				expect(written?.id).toBeTruthy();
				expect(await heldBy(person, app)).toEqual([0, 0, 0]);
			},
		);

		it("leaves nothing when the access token is made from a refresh token that has gone", async () => {
			const { app, person } = await allowed();
			expect((await takeBack(person, app.clientId)).status).toBe(200);

			const refreshRow = await writeToken("oauth_refresh_token", person.userId, app.clientId);
			const access = await writeAccessTokenFrom(refreshRow?.id ?? "", person.userId, app.clientId);
			expect(access?.id).toBeTruthy();
			expect(await heldBy(person, app)).toEqual([0, 0, 0]);
		});

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"goes as it arrives in %s, once someone has been removed",
			async (table) => {
				const { owner, workspace, app, person, memberId } = await allowed();
				await remove(owner, workspace, memberId);

				await writeToken(table, person.userId, app.clientId);
				expect(await heldBy(person, app)).toEqual([0, 0, 0]);
			},
		);

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"stays in %s while they have allowed it",
			async (table) => {
				const { app, person } = await allowed();
				const before = await tokenRows(person.userId, app.clientId);
				await writeToken(table, person.userId, app.clientId);
				expect(await tokenRows(person.userId, app.clientId)).toBe(before + 1);
			},
		);

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"is not saved in %s by someone else's yes, or by theirs to another app",
			async (table) => {
				const { owner, workspace, app, person } = await allowed();
				const other = await newPerson();
				await join(other, workspace, owner);
				await signInToApp(app, other);
				await signInToApp(await newApp(owner, workspace), person);
				expect((await takeBack(person, app.clientId)).status).toBe(200);

				await writeToken(table, person.userId, app.clientId);
				expect(await heldBy(person, app)).toEqual([0, 0, 0]);
			},
		);

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"stays in %s for a first-party app, which does not ask",
			async (table) => {
				const person = await newPerson();
				const made = await firstPartyApp();
				const before = await tokenRows(person.userId, made.clientId);
				await writeToken(table, person.userId, made.clientId);
				expect(await tokenRows(person.userId, made.clientId)).toBe(before + 1);
			},
		);
	});

	describe("what it refuses", () => {
		it("says the same of what is not there, not theirs and never allowed", async () => {
			const { owner, workspace, app, person, tokens } = await allowed();
			const stranger = await newPerson();
			const member = await newPerson();
			await join(member, workspace, owner);

			const answers = await Promise.all(
				[
					takeBack(stranger, app.clientId),
					takeBack(member, app.clientId),
					takeBack(owner, app.clientId),
					takeBack(person, "no-such-app"),
				].map(async (answer) => {
					const response = await answer;
					return { status: response.status, body: await response.json() };
				}),
			);
			expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
			expect(answers[0]?.status).toBe(404);

			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(person, app)).toEqual([expect.any(Number), 1, 1]);
		});

		it("leaves a first-party app as it is", async () => {
			const person = await newPerson();
			const made = await firstPartyAppAllowedBy(person);
			expect((await takeBack(person, made.clientId)).status).toBe(404);
			expect(await heldBy(person, made)).toEqual([0, 0, 1]);
		});

		it.each([
			["another person's id beside it", (clientId: string) => ({ clientId, userId: "someone" })],
			["an empty id", () => ({ clientId: "" })],
			["nothing", () => ({})],
		])("wants an app's id and nothing else: %s", async (_name, body) => {
			const { app, person, tokens } = await allowed();
			const response = await api("/account/allowed-apps/take-back", {
				who: person,
				body: body(app.clientId),
			});
			expect(response.status).toBe(400);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
		});

		it("is for someone signed in, from this site", async () => {
			const { app, person, tokens } = await allowed();
			expect(
				(await api("/account/allowed-apps/take-back", { body: { clientId: app.clientId } })).status,
			).toBe(401);
			const elsewhere = await id.fetch(`${origin}/api/auth/account/allowed-apps/take-back`, {
				method: "POST",
				headers: {
					origin: "https://elsewhere.test",
					"cf-connecting-ip": newClient(),
					"content-type": "application/json",
					cookie: person.cookie,
				},
				body: JSON.stringify({ clientId: app.clientId }),
			});
			expect(elsewhere.status).toBe(403);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(person, app)).toEqual([expect.any(Number), 1, 1]);
		});

		it("stops someone going on about it", async () => {
			const person = await newPerson();
			const address = newClient();
			const statuses = [];
			for (let tries = 0; tries < 30; tries++) {
				const answer = await id.fetch(`${origin}/api/auth/account/allowed-apps/take-back`, {
					method: "POST",
					headers: {
						origin,
						"cf-connecting-ip": address,
						"content-type": "application/json",
						cookie: person.cookie,
					},
					body: JSON.stringify({ clientId: "no-such-app" }),
				});
				statuses.push(answer.status);
			}
			expect(statuses[0]).toBe(404);
			expect(statuses).toContain(429);
		});
	});

	it.each([
		"/oauth2/get-consent",
		"/oauth2/get-consents",
		"/oauth2/update-consent",
		"/oauth2/delete-consent",
	])("leaves no way to do half of it: %s", async (path) => {
		const { app, person, tokens } = await allowed();
		const consentOf = () =>
			id.db
				.prepare("SELECT id, scopes FROM oauth_consent WHERE user_id = ? AND client_id = ?")
				.bind(person.userId, app.clientId)
				.first<{ id: string; scopes: string }>();
		const before = await consentOf();
		expect(before).not.toBeNull();
		// The consent's own id, since an open route answers 404 to any other and would pass for closed.
		const got = await api(`${path}?id=${before?.id}`, { who: person });
		const posted = await api(path, {
			who: person,
			body: { id: before?.id, update: { scopes: ["openid"] } },
		});
		expect(got.status).toBe(404);
		expect(posted.status).toBe(404);
		expect(await consentOf()).toEqual(before);
		expect(await heldBy(person, app)).toEqual([expect.any(Number), 1, 1]);
		expect((await userinfo(tokens.access_token)).status).toBe(200);
	});

	it("says so in their activity, under the name it had", async () => {
		const { owner, workspace, app, person, memberId } = await allowed();
		expect((await takeBack(person, app.clientId)).status).toBe(200);
		await id.auditEventRecorded(person.userId, {
			type: "consent_revoked",
			app: app.clientId,
			workspace_id: workspace.id,
		});
		const [event] = (await id.auditEvents(person.userId)).filter(
			({ type }) => type === "consent_revoked",
		);
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({
			workspace: workspace.name,
			name: app.name,
		});

		// It is what they saw when they did it, so it stays after they have gone, and the app has.
		await remove(owner, workspace, memberId);
		const deleted = await api("/workspaces/apps/delete", {
			who: owner,
			body: { organizationId: workspace.id, clientId: app.clientId },
		});
		expect(deleted.status).toBe(200);
		expect(await appRowIn(app.clientId)).toBeNull();
		const seen = await api("/account/activity", { who: person });
		const { events } = (await seen.json()) as { events: { type: string; detail: string | null }[] };
		const listed = events.find(({ type }) => type === "consent_revoked");
		expect(JSON.parse(listed?.detail ?? "{}")).toMatchObject({ name: app.name });
	});
});

describe("groups", () => {
	interface Group {
		id: string;
		name: string;
	}

	let groupsMade = 0;

	async function newGroup(who: Who, workspace: Workspace, name = `Group ${++groupsMade}`) {
		const response = await api("/workspaces/groups/create", {
			who,
			body: { organizationId: workspace.id, name },
		});
		expect(response.status).toBe(200);
		const { id: groupId } = (await response.json()) as { id: string };
		return { id: groupId, name } satisfies Group;
	}

	async function putIn(who: Who, workspace: Workspace, group: Group, memberId: string) {
		const response = await api("/workspaces/groups/add-member", {
			who,
			body: { organizationId: workspace.id, groupId: group.id, memberId },
		});
		expect(response.status).toBe(200);
	}

	async function takeOut(who: Who, workspace: Workspace, group: Group, memberId: string) {
		const response = await api("/workspaces/groups/remove-member", {
			who,
			body: { organizationId: workspace.id, groupId: group.id, memberId },
		});
		expect(response.status).toBe(200);
	}

	async function namedBy(app: Pick<App, "clientId">) {
		const { results } = await id.db
			.prepare("SELECT group_id FROM workspace_app_group WHERE client_id = ?")
			.bind(app.clientId)
			.all<{ group_id: string }>();
		return results.map((row: { group_id: string }) => row.group_id);
	}

	/** As a page does that is up to date. */
	async function setGroups(
		who: Who,
		workspace: Workspace,
		app: Pick<App, "clientId">,
		groups: string[],
	) {
		return api("/workspaces/apps/set-groups", {
			who,
			body: {
				organizationId: workspace.id,
				clientId: app.clientId,
				groups,
				was: await namedBy(app),
			},
		});
	}

	async function narrow(who: Who, workspace: Workspace, app: App, groups: Group[]) {
		const response = await setGroups(
			who,
			workspace,
			app,
			groups.map((group) => group.id),
		);
		expect(response.status).toBe(200);
	}

	/** A workspace with an app that is still open to everyone, and one person in a group and one not. */
	async function aWorkspace() {
		const owner = await newPerson("Owner");
		const workspace = await newWorkspace(owner);
		const app = await newApp(owner, workspace);
		const group = await newGroup(owner, workspace, "Engineers");
		const inside = await newPerson("Inside");
		const insideId = await join(inside, workspace, owner);
		await putIn(owner, workspace, group, insideId);
		const outside = await newPerson("Outside");
		const outsideId = await join(outside, workspace, owner);
		return { owner, workspace, app, group, inside, insideId, outside, outsideId };
	}

	async function aNarrowedApp() {
		const made = await aWorkspace();
		await narrow(made.owner, made.workspace, made.app, [made.group]);
		return made;
	}

	let written = 0;

	/** A crossing cannot be timed from outside, so this writes the row the provider would be writing. */
	function writeToken(table: string, userId: string, clientId: string) {
		const rowId = `group-written-${++written}`;
		return id.db
			.prepare(
				`INSERT INTO ${table} (id, token, client_id, user_id, scopes, expires_at, created_at)
				VALUES (?1, ?1, ?2, ?3, '"[\\"openid\\"]"', ?4, ?4) RETURNING id`,
			)
			.bind(rowId, clientId, userId, Date.now() + 3_600_000)
			.first<{ id: string }>();
	}

	function appNamesGroup(app: Pick<App, "clientId">, group: Group, workspace: Workspace) {
		return id.db
			.prepare(
				"INSERT INTO workspace_app_group (client_id, group_id, organization_id, created_at) VALUES (?, ?, ?, ?)",
			)
			.bind(app.clientId, group.id, workspace.id, Date.now())
			.run();
	}

	describe("managing them", () => {
		it("makes, renames and deletes one, and the workspace's page says so", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			expect((await details(owner, workspace)).groups).toEqual([]);

			const group = await newGroup(owner, workspace, "Sales");
			expect((await details(owner, workspace)).groups).toEqual([
				{ id: group.id, name: "Sales", members: [] },
			]);

			const renamed = await api("/workspaces/groups/rename", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id, name: "Revenue" },
			});
			expect(renamed.status).toBe(200);
			expect((await details(owner, workspace)).groups[0]?.name).toBe("Revenue");

			const deleted = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id },
			});
			expect(deleted.status).toBe(200);
			expect((await details(owner, workspace)).groups).toEqual([]);
		});

		it("adds someone once, and takes them out", async () => {
			const { owner, workspace, group, insideId, outsideId } = await aWorkspace();
			await putIn(owner, workspace, group, outsideId);
			await putIn(owner, workspace, group, outsideId);
			const [listed] = (await details(owner, workspace)).groups;
			expect(listed?.members).toEqual([insideId, outsideId]);

			await takeOut(owner, workspace, group, outsideId);
			// They were out already, which is what was asked for.
			await takeOut(owner, workspace, group, outsideId);
			expect((await details(owner, workspace)).groups[0]?.members).toEqual([insideId]);
		});

		it("is for an admin as much as an owner", async () => {
			const { owner, workspace } = await aWorkspace();
			const admin = await newPerson("Admin");
			await join(admin, workspace, owner, "admin");
			await newGroup(admin, workspace, "From an admin");
			expect((await details(owner, workspace)).groups.map(({ name }) => name)).toContain(
				"From an admin",
			);
		});

		describe("refusing whoever may not", () => {
			async function requests() {
				const made = await aWorkspace();
				const { workspace, group, app, insideId } = made;
				const organizationId = workspace.id;
				const groupId = group.id;
				const calls: [string, object][] = [
					["/workspaces/groups/create", { organizationId, name: "Theirs" }],
					["/workspaces/groups/rename", { organizationId, groupId, name: "Theirs" }],
					["/workspaces/groups/delete", { organizationId, groupId }],
					["/workspaces/groups/add-member", { organizationId, groupId, memberId: made.outsideId }],
					["/workspaces/groups/remove-member", { organizationId, groupId, memberId: insideId }],
					[
						"/workspaces/apps/set-groups",
						{ organizationId, clientId: app.clientId, groups: [groupId], was: [] },
					],
				];
				const before = () => details(made.owner, workspace);
				return { ...made, calls, was: await before(), now: before };
			}

			it("tells a plain member they may not, and changes nothing", async () => {
				const { calls, inside, was, now } = await requests();
				for (const [path, body] of calls) {
					expect((await api(path, { who: inside, body })).status, path).toBe(403);
				}
				expect(await now()).toEqual(was);
			});

			it("tells someone outside there is no such workspace, and changes nothing", async () => {
				const { calls, was, now } = await requests();
				const stranger = await newPerson("Stranger");
				for (const [path, body] of calls) {
					const response = await api(path, { who: stranger, body });
					expect(response.status, path).toBe(404);
					expect(await response.json(), path).toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
				}
				expect(await now()).toEqual(was);
			});

			it("wants someone signed in, from this site", async () => {
				const { calls, owner, was, now } = await requests();
				for (const [path, body] of calls) {
					expect((await api(path, { body })).status, path).toBe(401);
					const elsewhere = await id.fetch(`${origin}/api/auth${path}`, {
						method: "POST",
						headers: {
							origin: "https://elsewhere.test",
							"cf-connecting-ip": newClient(),
							"content-type": "application/json",
							cookie: owner.cookie,
						},
						body: JSON.stringify(body),
					});
					expect(elsewhere.status, path).toBe(403);
				}
				expect(await now()).toEqual(was);
			});

			it("wants what each asks for and nothing else", async () => {
				const { calls, owner, workspace, app, was, now } = await requests();
				for (const [path, body] of calls) {
					const response = await api(path, { who: owner, body: { ...body, role: "owner" } });
					expect(response.status, path).toBe(400);
				}
				const notAList = await api("/workspaces/apps/set-groups", {
					who: owner,
					body: {
						organizationId: workspace.id,
						clientId: app.clientId,
						groups: "everyone",
						was: [],
					},
				});
				expect(notAList.status).toBe(400);
				expect(await now()).toEqual(was);
			});

			it("reads no more of a list than a workspace can hold", async () => {
				const { owner, workspace, app } = await aWorkspace();
				const ids = (length: number) => Array.from({ length }, (_, index) => `group-${index}`);
				const save = (groups: string[], was: string[]) =>
					api("/workspaces/apps/set-groups", {
						who: owner,
						body: { organizationId: workspace.id, clientId: app.clientId, groups, was },
					});
				// As many as it can hold get as far as being looked at, and these are not there.
				expect((await save(ids(50), [])).status).toBe(404);
				expect((await save(ids(51), [])).status).toBe(400);
				expect((await save([], ids(50))).status).toBe(409);
				expect((await save([], ids(51))).status).toBe(400);
			});

			it("stops someone going on about it, past what setting up a team takes", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				const address = newClient();
				const statuses = [];
				for (let tries = 0; tries < 80; tries++) {
					const answer = await id.fetch(`${origin}/api/auth/workspaces/groups/create`, {
						method: "POST",
						headers: {
							origin,
							"cf-connecting-ip": address,
							"content-type": "application/json",
							cookie: owner.cookie,
						},
						body: JSON.stringify({ organizationId: workspace.id, name: "!!!" }),
					});
					statuses.push(answer.status);
				}
				expect(new Set(statuses.slice(0, 50))).toEqual(new Set([400]));
				expect(statuses).toContain(429);
			});
		});

		describe("names", () => {
			it.each([
				["an empty one", ""],
				["one that starts with a space", " Sales"],
				["one that ends with a space", "Sales "],
				["one that is too long", "x".repeat(61)],
				["one with a control character", "Sa\u0007les"],
				["one with hidden direction marks", "Sales‮"],
				["one with nothing to match on", "!!!"],
			])("refuses %s", async (_name, name) => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				const group = await newGroup(owner, workspace, "Sales team");
				const body = { organizationId: workspace.id, name };
				const created = await api("/workspaces/groups/create", { who: owner, body });
				const renamed = await api("/workspaces/groups/rename", {
					who: owner,
					body: { ...body, groupId: group.id },
				});
				expect(created.status).toBe(400);
				expect(renamed.status).toBe(400);
				expect((await details(owner, workspace)).groups.map((held) => held.name)).toEqual([
					"Sales team",
				]);
			});

			it("takes a name in any language", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				const group = await newGroup(owner, workspace, "Satış Ekibi");
				expect(group.id).toBeTruthy();
			});

			it("will not let two pass for one, since apps match on them", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				await newGroup(owner, workspace, "Sales");
				const other = await newGroup(owner, workspace, "Support");
				for (const name of ["Sales", "sales", "SALES", "S.A.L.E.S", "Ｓａｌｅｓ"]) {
					const created = await api("/workspaces/groups/create", {
						who: owner,
						body: { organizationId: workspace.id, name },
					});
					expect(created.status, name).toBe(400);
					expect(await created.json(), name).toMatchObject({ code: "GROUP_NAME_TAKEN" });
				}
				const renamed = await api("/workspaces/groups/rename", {
					who: owner,
					body: { organizationId: workspace.id, groupId: other.id, name: "sales" },
				});
				expect(renamed.status).toBe(400);
				expect(await renamed.json()).toMatchObject({ code: "GROUP_NAME_TAKEN" });
			});

			it("holds to that in the database too", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				await newGroup(owner, workspace, "Sales");
				await expect(
					id.db
						.prepare(
							`INSERT INTO workspace_group (id, organization_id, name, comparable_name, created_at, updated_at)
							VALUES ('copy', ?1, 'sales', 'sales', 0, 0)`,
						)
						.bind(workspace.id)
						.run(),
				).rejects.toThrow(/UNIQUE/i);
			});

			it("lets a group change how its own name is written", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				const group = await newGroup(owner, workspace, "Sales");
				const renamed = await api("/workspaces/groups/rename", {
					who: owner,
					body: { organizationId: workspace.id, groupId: group.id, name: "SALES" },
				});
				expect(renamed.status).toBe(200);
				expect((await details(owner, workspace)).groups[0]?.name).toBe("SALES");
			});

			it("goes by the new name once a group has changed it, and frees the old one", async () => {
				const owner = await newPerson();
				const workspace = await newWorkspace(owner);
				const group = await newGroup(owner, workspace, "Sales");
				const renamed = await api("/workspaces/groups/rename", {
					who: owner,
					body: { organizationId: workspace.id, groupId: group.id, name: "Support" },
				});
				expect(renamed.status).toBe(200);

				const taken = await api("/workspaces/groups/create", {
					who: owner,
					body: { organizationId: workspace.id, name: "support" },
				});
				expect(taken.status).toBe(400);
				expect(await taken.json()).toMatchObject({ code: "GROUP_NAME_TAKEN" });
				await newGroup(owner, workspace, "Sales");
			});

			it("leaves another workspace free to use the same one", async () => {
				const owner = await newPerson();
				await newGroup(owner, await newWorkspace(owner), "Sales");
				await newGroup(owner, await newWorkspace(owner), "Sales");
			});
		});

		it("stops at as many as a workspace can hold", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			await id.db
				.prepare(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
					INSERT INTO workspace_group (id, organization_id, name, comparable_name, created_at, updated_at)
					SELECT ?1 || i, ?1, 'Group ' || i, 'group' || i, 0, 0 FROM n`,
				)
				.bind(workspace.id)
				.run();
			const refused = await api("/workspaces/groups/create", {
				who: owner,
				body: { organizationId: workspace.id, name: "One more" },
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toMatchObject({ code: "TOO_MANY_GROUPS" });
		});

		describe("another workspace's", () => {
			async function twoWorkspaces() {
				const made = await aWorkspace();
				const theirOwner = await newPerson("Other owner");
				const theirs = await newWorkspace(theirOwner, "Theirs");
				const theirGroup = await newGroup(theirOwner, theirs, "Their group");
				const theirApp = await newApp(theirOwner, theirs);
				const theirMember = await newPerson("Theirs");
				const theirMemberId = await join(theirMember, theirs, theirOwner);
				await putIn(theirOwner, theirs, theirGroup, theirMemberId);
				return { ...made, theirOwner, theirs, theirGroup, theirApp, theirMemberId };
			}

			it("is nothing here, whichever way it is asked", async () => {
				const {
					owner,
					workspace,
					group,
					app,
					outsideId,
					theirOwner,
					theirs,
					theirGroup,
					theirApp,
					theirMemberId,
				} = await twoWorkspaces();
				const organizationId = workspace.id;
				const cases: [string, object, string][] = [
					[
						"/workspaces/groups/rename",
						{ organizationId, groupId: theirGroup.id, name: "Ours" },
						"GROUP_NOT_FOUND",
					],
					[
						"/workspaces/groups/delete",
						{ organizationId, groupId: theirGroup.id },
						"GROUP_NOT_FOUND",
					],
					[
						"/workspaces/groups/add-member",
						{ organizationId, groupId: theirGroup.id, memberId: outsideId },
						"GROUP_NOT_FOUND",
					],
					[
						"/workspaces/groups/add-member",
						{ organizationId, groupId: group.id, memberId: theirMemberId },
						"MEMBER_NOT_FOUND",
					],
					[
						"/workspaces/groups/remove-member",
						{ organizationId, groupId: theirGroup.id, memberId: theirMemberId },
						"GROUP_NOT_FOUND",
					],
					[
						"/workspaces/groups/remove-member",
						{ organizationId, groupId: group.id, memberId: theirMemberId },
						"MEMBER_NOT_FOUND",
					],
					[
						"/workspaces/apps/set-groups",
						{ organizationId, clientId: app.clientId, groups: [theirGroup.id], was: [] },
						"GROUP_NOT_FOUND",
					],
					[
						"/workspaces/apps/set-groups",
						{ organizationId, clientId: theirApp.clientId, groups: [], was: [] },
						"APP_NOT_FOUND",
					],
				];
				for (const [path, body, code] of cases) {
					const response = await api(path, { who: owner, body });
					expect(response.status, `${path} ${code}`).toBe(404);
					expect(await response.json()).toMatchObject({ code });
				}
				const theirDetails = await details(theirOwner, theirs);
				expect(theirDetails.groups[0]?.name).toBe("Their group");
				expect(theirDetails.apps[0]?.groups).toEqual([]);
				expect((await details(owner, workspace)).apps[0]?.groups).toEqual([]);
			});

			it("is not something a first-party app can be narrowed to", async () => {
				const { owner, workspace } = await aWorkspace();
				const made = await firstPartyApp();
				const response = await setGroups(owner, workspace, made, []);
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({ code: "APP_NOT_FOUND" });
			});

			it("cannot be written into this one's rows, even by hand", async () => {
				const { workspace, group, app, outsideId, theirs, theirGroup, theirApp, theirMemberId } =
					await twoWorkspaces();
				const first = await firstPartyApp();
				const member = (groupId: string, memberId: string, organizationId: string) =>
					id.db
						.prepare(
							"INSERT INTO workspace_group_member (group_id, member_id, organization_id, created_at) VALUES (?, ?, ?, 0)",
						)
						.bind(groupId, memberId, organizationId)
						.run();
				// Whichever workspace the row says, one side of it is in the other.
				await expect(member(group.id, theirMemberId, workspace.id)).rejects.toThrow(/FOREIGN KEY/i);
				await expect(member(group.id, theirMemberId, theirs.id)).rejects.toThrow(/FOREIGN KEY/i);
				await expect(member(theirGroup.id, outsideId, workspace.id)).rejects.toThrow(
					/FOREIGN KEY/i,
				);
				await expect(appNamesGroup(app, theirGroup, workspace)).rejects.toThrow(/FOREIGN KEY/i);
				await expect(appNamesGroup(app, theirGroup, theirs)).rejects.toThrow(/FOREIGN KEY/i);
				await expect(appNamesGroup(theirApp, group, workspace)).rejects.toThrow(/FOREIGN KEY/i);
				await expect(appNamesGroup(first, group, workspace)).rejects.toThrow(/FOREIGN KEY/i);
			});
		});

		it("says so in the activity of whoever did it, and whoever it was done to", async () => {
			const { owner, workspace, group, outside, outsideId, app } = await aWorkspace();
			await putIn(owner, workspace, group, outsideId);
			await id.auditEventRecorded(outside.userId, {
				type: "group_member_added",
				actor_id: owner.userId,
				workspace_id: workspace.id,
			});
			await takeOut(owner, workspace, group, outsideId);
			await id.auditEventRecorded(outside.userId, {
				type: "group_member_removed",
				actor_id: owner.userId,
				workspace_id: workspace.id,
			});
			const [event] = (await id.auditEvents(outside.userId)).filter(
				({ type }) => type === "group_member_removed",
			);
			expect(JSON.parse(event?.detail ?? "{}")).toEqual({
				workspace: workspace.name,
				group: group.name,
			});

			await narrow(owner, workspace, app, [group]);
			await id.auditEventRecorded(owner.userId, {
				type: "app_groups_changed",
				app: app.clientId,
				workspace_id: workspace.id,
			});
			await id.auditEventRecorded(owner.userId, { type: "group_created" });

			const spare = await newGroup(owner, workspace, "Spare");
			const deleted = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: spare.id },
			});
			expect(deleted.status).toBe(200);
			await id.auditEventRecorded(owner.userId, {
				type: "group_deleted",
				workspace_id: workspace.id,
			});
			const [gone] = (await id.auditEvents(owner.userId)).filter(
				({ type }) => type === "group_deleted",
			);
			expect(JSON.parse(gone?.detail ?? "{}")).toEqual({
				workspace: workspace.name,
				group: "Spare",
			});
		});

		it("says nothing happened when nothing did", async () => {
			const { owner, workspace, group, outside, outsideId, inside, insideId } = await aWorkspace();
			await takeOut(owner, workspace, group, outsideId);
			await putIn(owner, workspace, group, insideId);
			// Something to wait for, recorded after the two that should have left no trace.
			await putIn(owner, workspace, group, outsideId);
			await id.auditEventRecorded(outside.userId, { type: "group_member_added" });
			const of = async (userId: string, type: string) =>
				(await id.auditEvents(userId)).filter((event) => event.type === type).length;
			expect(await of(outside.userId, "group_member_removed")).toBe(0);
			expect(await of(inside.userId, "group_member_added")).toBe(1);
		});
	});

	describe("who sees them", () => {
		it("shows an admin every group, and who is in it", async () => {
			const { owner, workspace, group, insideId } = await aWorkspace();
			const other = await newGroup(owner, workspace, "Another");
			const { groups } = await details(owner, workspace);
			expect(groups).toEqual([
				{ id: other.id, name: "Another", members: [] },
				{ id: group.id, name: group.name, members: [insideId] },
			]);
		});

		it("shows a member only the groups they are in, with only themselves in them", async () => {
			const { owner, workspace, group, inside, insideId, outside, outsideId } = await aWorkspace();
			await putIn(owner, workspace, group, outsideId);
			await newGroup(owner, workspace, "Not theirs");

			expect((await details(inside, workspace)).groups).toEqual([
				{ id: group.id, name: group.name, members: [insideId] },
			]);
			expect((await details(outside, workspace)).groups).toEqual([
				{ id: group.id, name: group.name, members: [outsideId] },
			]);
		});

		it("shows a member none when they are in none, and no apps' groups at all", async () => {
			const { workspace, outside, owner, app, group } = await aWorkspace();
			await narrow(owner, workspace, app, [group]);
			const seen = await details(outside, workspace);
			expect(seen.groups).toEqual([]);
			expect(seen.apps).toEqual([]);
		});

		it("shows an admin which groups each app is narrowed to", async () => {
			const { owner, workspace, app, group } = await aNarrowedApp();
			const open = await newApp(owner, workspace);
			const { apps } = await details(owner, workspace);
			expect(apps.find(({ clientId }) => clientId === app.clientId)?.groups).toEqual([group.id]);
			expect(apps.find(({ clientId }) => clientId === open.clientId)?.groups).toEqual([]);
		});
	});

	describe("who gets in", () => {
		it("lets in someone in the group, and not someone only in the workspace", async () => {
			const { app, inside, outside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			expect((await userinfo(tokens.access_token)).status).toBe(200);

			const refused = await authorize(app, outside);
			expectRefused(refused, app);
			await id.auditEventRecorded(outside.userId, {
				type: "refused",
				app: app.clientId,
				detail: "authorization",
			});
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
		});

		it("keeps them from the page that asks, and from a quiet answer", async () => {
			const { app, outside } = await aNarrowedApp();
			expectRefused(await authorize(app, outside, { prompt: "none" }), app);
			expectRefused(await authorize(app, outside, { prompt: "consent" }), app);
			// A wrong request would otherwise send them to the app, which is no business of theirs.
			const wrong = await authorize(app, outside, { response_type: "token" });
			expect(wrong.location.host).not.toBe(app.host);
			expect(wrong.location.pathname).toBe("/no-access");
		});

		it("does not let in the workspace's owner for being its owner", async () => {
			const { owner, app, group, workspace } = await aNarrowedApp();
			expectRefused(await authorize(app, owner), app);
			const ownerId = (await details(owner, workspace)).you.memberId;
			await putIn(owner, workspace, group, ownerId);
			await signInToApp(app, owner);
		});

		it("refuses on refresh too, however they came to be outside", async () => {
			const { workspace, app, group, outside } = await aWorkspace();
			const { tokens } = await signInToApp(app, outside);
			// By hand, so that their tokens stay and only the check stands in the way.
			await appNamesGroup(app, group, workspace);
			await expect(refresh(app, tokens.refresh_token)).rejects.toThrow();
			await id.auditEventRecorded(outside.userId, {
				type: "refused",
				app: app.clientId,
				detail: "refresh_token",
			});
		});

		it("refuses a code handed out before it was narrowed", async () => {
			const { owner, workspace, app, group, outside } = await aWorkspace();
			const handed = await agree(await authorize(app, outside), outside);
			expect(handed.location.searchParams.has("code")).toBe(true);
			await narrow(owner, workspace, app, [group]);
			await expect(exchange(app, handed)).rejects.toThrow();
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
		});

		it("sends nobody on who answers the page after it was narrowed", async () => {
			const { owner, workspace, app, group, outside } = await aWorkspace();
			const asked = await authorize(app, outside);
			expect(asked.location.pathname).toBe("/consent");
			await narrow(owner, workspace, app, [group]);
			const answered = await api("/oauth2/consent", {
				who: outside,
				body: { accept: true, oauth_query: asked.location.search.slice(1) },
			});
			expect(new URL(((await answered.json()) as { url: string }).url, origin).pathname).toBe(
				"/no-access",
			);
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
		});

		it("lets nobody in through a group with nobody in it", async () => {
			const { owner, workspace, app, inside } = await aWorkspace();
			const empty = await newGroup(owner, workspace, "Nobody yet");
			await narrow(owner, workspace, app, [empty]);
			expectRefused(await authorize(app, inside), app);
			expectRefused(await authorize(app, owner), app);
		});

		it("leaves an app closed, not open, when its last person is taken out", async () => {
			const { owner, workspace, app, group, inside, insideId, outside } = await aNarrowedApp();
			await takeOut(owner, workspace, group, insideId);
			expectRefused(await authorize(app, inside), app);
			expectRefused(await authorize(app, outside), app);
		});

		it("lets in someone in either of two groups", async () => {
			const { owner, workspace, app, group, inside, outside, outsideId } = await aWorkspace();
			const second = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, second, outsideId);
			await narrow(owner, workspace, app, [group, second]);
			await signInToApp(app, inside);
			await signInToApp(app, outside);
		});

		it("does not let them in through the group of another app", async () => {
			const { owner, workspace, app, inside, outside, outsideId } = await aNarrowedApp();
			const other = await newApp(owner, workspace);
			const theirs = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, theirs, outsideId);
			await narrow(owner, workspace, other, [theirs]);

			expectRefused(await authorize(other, inside), other);
			expectRefused(await authorize(app, outside), app);
			await signInToApp(other, outside);
			await signInToApp(app, inside);
		});

		it("lets them in once they are put in the group", async () => {
			const { owner, workspace, app, group, outside, outsideId } = await aNarrowedApp();
			expectRefused(await authorize(app, outside), app);
			await putIn(owner, workspace, group, outsideId);
			await signInToApp(app, outside);
		});

		it("lets everyone in again when an admin chooses that", async () => {
			const { owner, workspace, app, outside } = await aNarrowedApp();
			expectRefused(await authorize(app, outside), app);
			await narrow(owner, workspace, app, []);
			expect((await details(owner, workspace)).apps[0]?.groups).toEqual([]);
			await signInToApp(app, outside);
		});

		it("leaves someone outside the workspace out, whatever the app says", async () => {
			const { app } = await aNarrowedApp();
			const stranger = await newPerson("Stranger");
			expectRefused(await authorize(app, stranger), app);
		});

		it("is not fooled by a group of the same name in another workspace", async () => {
			const { app, outside, group } = await aNarrowedApp();
			const elsewhere = await newWorkspace(outside, "Elsewhere");
			const same = await newGroup(outside, elsewhere, group.name);
			const ownId = (await details(outside, elsewhere)).you.memberId;
			await putIn(outside, elsewhere, same, ownId);
			expectRefused(await authorize(app, outside), app);
		});
	});

	describe("losing access", () => {
		it("ends what someone holds when they are taken out, and leaves them in the workspace", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			expect((await heldBy(inside, app))[2]).toBe(1);

			await takeOut(owner, workspace, group, insideId);

			expect((await userinfo(tokens.access_token)).status).toBe(401);
			await expect(refresh(app, tokens.refresh_token)).rejects.toThrow();
			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			expect((await details(inside, workspace)).you.memberId).toBe(insideId);
		});

		it("ends an access token with no refresh token behind it", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			const asked = await authorize(app, inside, { scope: "openid" });
			const { tokens } = await exchange(app, await agree(asked, inside));
			expect(tokens.refresh_token).toBeUndefined();
			expect(await heldBy(inside, app)).toEqual([1, 0, 1]);

			await takeOut(owner, workspace, group, insideId);
			expect((await userinfo(tokens.access_token)).status).toBe(401);
			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
		});

		it("ends a refresh token with no access token left beside it", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			await signInToApp(app, inside);
			await id.db
				.prepare("DELETE FROM oauth_access_token WHERE user_id = ?")
				.bind(inside.userId)
				.run();
			expect(await heldBy(inside, app)).toEqual([0, 1, 1]);

			await takeOut(owner, workspace, group, insideId);
			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
		});

		it("leaves them what another of their groups still opens", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aWorkspace();
			const second = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, second, insideId);
			await narrow(owner, workspace, app, [group, second]);
			const { tokens } = await signInToApp(app, inside);

			await takeOut(owner, workspace, group, insideId);

			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await refresh(app, tokens.refresh_token)).toMatchObject({
				access_token: expect.any(String),
			});
			expect((await heldBy(inside, app))[2]).toBe(1);

			await takeOut(owner, workspace, second, insideId);
			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
		});

		// An access token goes with the refresh token behind it, so holding one without the other
		// shows that it goes by itself.
		describe.each([
			["tokens of both kinds", (app: App, person: Person) => signInToApp(app, person)],
			[
				"an access token alone",
				async (app: App, person: Person) =>
					exchange(app, await agree(await authorize(app, person, { scope: "openid" }), person)),
			],
		] as const)("holding %s", (_holding, signIn) => {
			it("ends it, though someone else is in another group the app names", async () => {
				const { owner, workspace, app, group, inside, insideId, outsideId } = await aWorkspace();
				const second = await newGroup(owner, workspace, "Designers");
				await putIn(owner, workspace, second, outsideId);
				await narrow(owner, workspace, app, [group, second]);
				await signIn(app, inside);
				expect((await heldBy(inside, app))[0]).toBe(1);

				await takeOut(owner, workspace, group, insideId);
				expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			});

			it("ends it, though another of their groups opens another app", async () => {
				const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
				const second = await newGroup(owner, workspace, "Designers");
				await putIn(owner, workspace, second, insideId);
				const elsewhere = await newApp(owner, workspace);
				await narrow(owner, workspace, elsewhere, [second]);
				await signIn(app, inside);
				expect((await heldBy(inside, app))[0]).toBe(1);

				await takeOut(owner, workspace, group, insideId);
				expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			});

			it("ends it when the app is narrowed, though one of their groups opens another app", async () => {
				const { owner, workspace, app, group, outside, outsideId } = await aWorkspace();
				const second = await newGroup(owner, workspace, "Designers");
				await putIn(owner, workspace, second, outsideId);
				await narrow(owner, workspace, await newApp(owner, workspace), [second]);
				await signIn(app, outside);
				expect((await heldBy(outside, app))[0]).toBe(1);

				await narrow(owner, workspace, app, [group]);
				expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
			});
		});

		it("takes only what that group opened, and only from them", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			const open = await newApp(owner, workspace);
			const elsewhere = await newApp(owner, workspace);
			const second = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, second, insideId);
			await narrow(owner, workspace, elsewhere, [second]);
			const colleague = await newPerson("Colleague");
			const colleagueId = await join(colleague, workspace, owner);
			await putIn(owner, workspace, group, colleagueId);

			const signedIn = await signInToApp(app, inside);
			const inOpen = await signInToApp(open, inside);
			const inElsewhere = await signInToApp(elsewhere, inside);
			const theirs = await signInToApp(app, colleague);

			await takeOut(owner, workspace, group, insideId);

			expect((await userinfo(signedIn.tokens.access_token)).status).toBe(401);
			expect((await userinfo(inOpen.tokens.access_token)).status).toBe(200);
			expect((await userinfo(inElsewhere.tokens.access_token)).status).toBe(200);
			expect((await userinfo(theirs.tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, open)).toEqual([1, 1, 1]);
			expect(await heldBy(inside, elsewhere)).toEqual([1, 1, 1]);
			expect(await heldBy(colleague, app)).toEqual([1, 1, 1]);
		});

		it("asks them again when they are put back", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			await signInToApp(app, inside);
			await takeOut(owner, workspace, group, insideId);
			await putIn(owner, workspace, group, insideId);
			const asked = await authorize(app, inside);
			expect(asked.location.pathname).toBe("/consent");
		});

		it("ends what those left out hold when an app is narrowed, and only theirs", async () => {
			const { owner, workspace, app, group, inside, outside } = await aWorkspace();
			const kept = await signInToApp(app, inside);
			const ended = await signInToApp(app, outside);
			const inAnother = await signInToApp(await newApp(owner, workspace), outside);

			await narrow(owner, workspace, app, [group]);

			expect((await userinfo(ended.tokens.access_token)).status).toBe(401);
			await expect(refresh(app, ended.tokens.refresh_token)).rejects.toThrow();
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
			expect((await userinfo(kept.tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, app)).toEqual([1, 1, 1]);
			expect((await userinfo(inAnother.tokens.access_token)).status).toBe(200);
		});

		it.each([
			["an access token with no refresh token", { scope: "openid" }, [1, 0, 1]],
			["both", {}, [1, 1, 1]],
		])("ends %s when an app is narrowed", async (_name, params, before) => {
			const { owner, workspace, app, group, outside } = await aWorkspace();
			const asked = await authorize(app, outside, params);
			await exchange(app, await agree(asked, outside));
			expect(await heldBy(outside, app)).toEqual(before);
			await narrow(owner, workspace, app, [group]);
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
		});

		it("ends a refresh token with no access token beside it when an app is narrowed", async () => {
			const { owner, workspace, app, group, outside } = await aWorkspace();
			await signInToApp(app, outside);
			await id.db
				.prepare("DELETE FROM oauth_access_token WHERE user_id = ?")
				.bind(outside.userId)
				.run();
			await narrow(owner, workspace, app, [group]);
			expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
		});

		it("strands nobody when an app is narrowed to two groups at once", async () => {
			const { owner, workspace, app, group, inside, outside, outsideId } = await aWorkspace();
			const second = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, second, outsideId);
			const first = await signInToApp(app, inside);
			const other = await signInToApp(app, outside);

			await narrow(owner, workspace, app, [group, second]);

			expect((await userinfo(first.tokens.access_token)).status).toBe(200);
			expect((await userinfo(other.tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, app)).toEqual([1, 1, 1]);
			expect(await heldBy(outside, app)).toEqual([1, 1, 1]);
		});

		it("takes from those only in the old group when an app moves to another", async () => {
			const { owner, workspace, app, group, inside, outside, outsideId } = await aWorkspace();
			const next = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, next, outsideId);
			const both = await newPerson("Both");
			const bothId = await join(both, workspace, owner);
			await putIn(owner, workspace, group, bothId);
			await putIn(owner, workspace, next, bothId);
			await narrow(owner, workspace, app, [group]);
			await signInToApp(app, inside);
			await signInToApp(app, both);

			await narrow(owner, workspace, app, [next]);

			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			expect(await heldBy(both, app)).toEqual([1, 1, 1]);
			expectRefused(await authorize(app, inside), app);
			await signInToApp(app, outside);
			expect((await details(owner, workspace)).apps[0]?.groups).toEqual([next.id]);
		});

		it("takes nothing from anyone when an app is opened", async () => {
			const { owner, workspace, app, inside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			await narrow(owner, workspace, app, []);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, app)).toEqual([1, 1, 1]);
		});

		it("takes nothing when the list does not change", async () => {
			const { owner, workspace, app, group, inside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			await narrow(owner, workspace, app, [group]);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, app)).toEqual([1, 1, 1]);
			expect((await details(owner, workspace)).apps[0]?.groups).toEqual([group.id]);
		});

		it("takes a list naming a group twice as naming it once", async () => {
			const { owner, workspace, app, group } = await aWorkspace();
			const response = await setGroups(owner, workspace, app, [group.id, group.id]);
			expect(response.status).toBe(200);
			expect((await details(owner, workspace)).apps[0]?.groups).toEqual([group.id]);
		});

		it("leaves the other apps alone when one is narrowed", async () => {
			const { owner, workspace, app, group, outside } = await aWorkspace();
			const other = await newApp(owner, workspace);
			await signInToApp(other, outside);
			await narrow(owner, workspace, app, [group]);
			expect(await heldBy(outside, other)).toEqual([1, 1, 1]);
		});

		it("leaves first-party apps alone", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
			const first = await firstPartyApp();
			const asked = await authorize(
				{
					clientId: first.clientId,
					redirectUri: `https://first-party-${hosts}.apps.test/callback`,
				},
				inside,
			);
			expect(asked.location.searchParams.has("code")).toBe(true);
			await takeOut(owner, workspace, group, insideId);
			await narrow(owner, workspace, app, []);
			const again = await authorize(
				{
					clientId: first.clientId,
					redirectUri: `https://first-party-${hosts}.apps.test/callback`,
				},
				inside,
			);
			expect(again.location.searchParams.has("code")).toBe(true);
		});

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"lets no token into %s that was on its way when someone was taken out",
			async (table) => {
				const { owner, workspace, app, group, inside, insideId } = await aNarrowedApp();
				await signInToApp(app, inside);
				await takeOut(owner, workspace, group, insideId);
				expect((await writeToken(table, inside.userId, app.clientId))?.id).toBeTruthy();
				expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			},
		);

		it.each(["oauth_access_token", "oauth_refresh_token"])(
			"lets no token into %s that was on its way when an app was narrowed",
			async (table) => {
				const { owner, workspace, app, group, outside } = await aWorkspace();
				await signInToApp(app, outside);
				await narrow(owner, workspace, app, [group]);
				expect((await writeToken(table, outside.userId, app.clientId))?.id).toBeTruthy();
				expect(await heldBy(outside, app)).toEqual([0, 0, 0]);
			},
		);

		it("takes someone out of their groups when they leave, and brings them back in none", async () => {
			const { owner, workspace, app, inside, insideId } = await aNarrowedApp();
			await signInToApp(app, inside);
			await remove(owner, workspace, insideId);

			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
			expect(await count("workspace_group_member", "member_id = ?", insideId)).toBe(0);

			await join(inside, workspace, owner);
			expect((await details(inside, workspace)).groups).toEqual([]);
			expectRefused(await authorize(app, inside), app);
		});
	});

	describe("deleting one an app names", () => {
		it("refuses, says which apps, and changes nothing", async () => {
			const { owner, workspace, app, group, inside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			const response = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id },
			});
			expect(response.status).toBe(400);
			const failure = (await response.json()) as { code: string; message: string };
			expect(failure.code).toBe("GROUP_IN_USE");
			expect(failure.message).toContain(app.name);
			expect((await details(owner, workspace)).apps[0]?.groups).toEqual([group.id]);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
		});

		it("refuses when it is not the last either, since that too would change who gets in", async () => {
			const { owner, workspace, app, group } = await aWorkspace();
			const second = await newGroup(owner, workspace, "Designers");
			await narrow(owner, workspace, app, [group, second]);
			const response = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id },
			});
			expect(response.status).toBe(400);
		});

		it("is refused by the database too, so nothing can open an app that way", async () => {
			const { app, group, outside } = await aNarrowedApp();
			await expect(
				id.db.prepare("DELETE FROM workspace_group WHERE id = ?").bind(group.id).run(),
			).rejects.toThrow(/a group an app names/);
			expectRefused(await authorize(app, outside), app);
		});

		it("goes through once no app names it, and takes nobody's access", async () => {
			const { owner, workspace, app, group, inside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);
			await narrow(owner, workspace, app, []);
			const response = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id },
			});
			expect(response.status).toBe(200);
			expect(await count("workspace_group_member", "group_id = ?", group.id)).toBe(0);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
			expect(await heldBy(inside, app)).toEqual([1, 1, 1]);
		});

		it("is free once the app is deleted", async () => {
			const { owner, workspace, app, group } = await aNarrowedApp();
			const deleted = await api("/workspaces/apps/delete", {
				who: owner,
				body: { organizationId: workspace.id, clientId: app.clientId },
			});
			expect(deleted.status).toBe(200);
			expect(await count("workspace_app_group", "client_id = ?", app.clientId)).toBe(0);
			const response = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id },
			});
			expect(response.status).toBe(200);
		});

		it("does not stand in the way of deleting the workspace", async () => {
			const { owner, workspace, app, group, inside } = await aNarrowedApp();
			await signInToApp(app, inside);
			const deleted = await api("/organization/delete", {
				who: owner,
				body: { organizationId: workspace.id },
			});
			expect(deleted.status).toBe(200);
			expect(await count("workspace_group", "id = ?", group.id)).toBe(0);
			expect(await count("workspace_group_member", "group_id = ?", group.id)).toBe(0);
			expect(await count("workspace_app_group", "group_id = ?", group.id)).toBe(0);
			expect(await appRowIn(app.clientId)).toBeNull();
			expect(await heldBy(inside, app)).toEqual([0, 0, 0]);
		});
	});

	describe("a page left open", () => {
		function save(owner: Who, workspace: Workspace, app: App, groups: string[], was?: string[]) {
			return api("/workspaces/apps/set-groups", {
				who: owner,
				body: { organizationId: workspace.id, clientId: app.clientId, groups, was },
			});
		}

		it("cannot open an app someone has narrowed since, by being saved as it stands", async () => {
			const { owner, workspace, app, group, inside, outside } = await aNarrowedApp();
			const { tokens } = await signInToApp(app, inside);

			const stale = await save(owner, workspace, app, [], []);

			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({ code: "APP_GROUPS_CHANGED" });
			expect(await namedBy(app)).toEqual([group.id]);
			expectRefused(await authorize(app, outside), app);
			expect((await userinfo(tokens.access_token)).status).toBe(200);
		});

		it("cannot narrow an app further than what it saw, and costs nobody their access", async () => {
			const { owner, workspace, app, group, outside, outsideId } = await aWorkspace();
			const other = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, other, outsideId);
			await narrow(owner, workspace, app, [group, other]);
			const { tokens } = await signInToApp(app, outside);

			expect((await save(owner, workspace, app, [group.id], [group.id])).status).toBe(409);

			expect(new Set(await namedBy(app))).toEqual(new Set([group.id, other.id]));
			expect((await userinfo(tokens.access_token)).status).toBe(200);
		});

		it("is refused for having seen more, or other groups, than there are", async () => {
			const { owner, workspace, app, group } = await aNarrowedApp();
			const other = await newGroup(owner, workspace, "Designers");

			for (const was of [[group.id, other.id], [other.id], []]) {
				expect((await save(owner, workspace, app, [group.id], was)).status, String(was)).toBe(409);
			}
		});

		it("is fine in any order, and when it says the same group twice", async () => {
			const { owner, workspace, app, group } = await aWorkspace();
			const other = await newGroup(owner, workspace, "Designers");
			await narrow(owner, workspace, app, [group, other]);

			const inOrder = await save(owner, workspace, app, [other.id, group.id], [other.id, group.id]);
			expect(inOrder.status).toBe(200);
			const reversed = await save(
				owner,
				workspace,
				app,
				[group.id, other.id],
				[group.id, other.id],
			);
			expect(reversed.status).toBe(200);
			const twice = await save(
				owner,
				workspace,
				app,
				[group.id, other.id],
				[group.id, group.id, other.id],
			);
			expect(twice.status).toBe(200);
		});

		it("has to say what it saw", async () => {
			const { owner, workspace, app, group } = await aNarrowedApp();
			expect((await save(owner, workspace, app, [])).status).toBe(400);
			expect(await namedBy(app)).toEqual([group.id]);
		});
	});

	describe("a sign-in from a while ago", () => {
		it("cannot do what can hand out or take away what an app gives", async () => {
			const { owner, workspace, app, group, outsideId } = await aWorkspace();
			const organizationId = workspace.id;
			await ageSession(owner);
			const was = await details(owner, workspace);

			for (const [path, body] of [
				["/workspaces/groups/rename", { organizationId, groupId: group.id, name: "Admins" }],
				[
					"/workspaces/groups/add-member",
					{ organizationId, groupId: group.id, memberId: outsideId },
				],
				[
					"/workspaces/apps/set-groups",
					{ organizationId, clientId: app.clientId, groups: [group.id], was: [] },
				],
			] as const) {
				const response = await api(path, { who: owner, body });
				expect(response.status, path).toBe(403);
				expect(await response.json(), path).toMatchObject({ code: "SESSION_NOT_FRESH" });
			}
			expect(await details(owner, workspace)).toEqual(was);
		});

		it("can do what gives nobody anything", async () => {
			const { owner, workspace, group, insideId } = await aWorkspace();
			await ageSession(owner);

			await takeOut(owner, workspace, group, insideId);
			const made = await newGroup(owner, workspace, "Designers");
			const deleted = await api("/workspaces/groups/delete", {
				who: owner,
				body: { organizationId: workspace.id, groupId: made.id },
			});
			expect(deleted.status).toBe(200);
		});
	});

	describe("someone an app is kept from", () => {
		const page = (path: string, who: Who, init: RequestInit = {}) =>
			id.fetch(`${origin}${path}`, {
				...init,
				headers: { "cf-connecting-ip": newClient(), cookie: who.cookie, accept: "text/html" },
			});

		async function namedApp() {
			const owner = await newPerson("Owner");
			const workspace = await newWorkspace(owner, "The Kept Guild");
			const app = await newApp(owner, workspace, "Kept Mirror");
			const group = await newGroup(owner, workspace, "Engineers");
			const inside = await newPerson("Inside");
			await putIn(owner, workspace, group, await join(inside, workspace, owner));
			const outside = await newPerson("Outside");
			await join(outside, workspace, owner);
			await narrow(owner, workspace, app, [group]);
			return { app, inside, outside };
		}

		it("hears nothing of it from the page that asks, and has nothing to answer", async () => {
			const { app, inside, outside } = await namedApp();
			const link = `/consent?client_id=${app.clientId}&scope=openid`;

			const sent = await page(link, outside, { redirect: "manual" });
			expect(sent.status).toBe(307);
			expect(new URL(sent.headers.get("location") ?? "", origin).pathname).toBe("/no-access");
			const html = await (await page(link, outside)).text();
			expect(html).not.toContain("Kept Mirror");
			expect(html).not.toContain("The Kept Guild");
			expect(html).not.toContain(app.host);

			// The same link names it to someone it would let in, so what is above is not for want of a name.
			const asked = await (await page(link, inside)).text();
			expect(asked).toContain("Kept Mirror");
			expect(asked).toContain("The Kept Guild");
		});

		it("is offered no way there from the page that turns them away", async () => {
			const { app, inside, outside } = await namedApp();
			const link = `/no-access?client_id=${app.clientId}&sig=x&redirect_uri=${encodeURIComponent(app.redirectUri)}`;

			const html = await (await page(link, outside)).text();
			expect(html).not.toContain("Back to");
			expect(html).not.toContain("Kept Mirror");

			expect(await (await page(link, inside)).text()).toContain("Back to");
		});

		it("is not told its name by their own activity", async () => {
			const { app, outside } = await namedApp();
			const refused = await authorize(app, outside);
			await api("/oauth2/consent", {
				who: outside,
				body: { accept: true, oauth_query: refused.location.search.slice(1) },
			});
			await id.auditEventRecorded(outside.userId, { type: "refused", app: app.clientId });

			const response = await api("/account/activity", { who: outside });
			const seen = await response.text();
			expect(seen).toContain('"refused"');
			expect(seen).not.toContain("Kept Mirror");
			expect(seen).not.toContain(app.clientId);
		});

		it("is told it again once they are let in", async () => {
			const owner = await newPerson("Owner");
			const workspace = await newWorkspace(owner);
			const app = await newApp(owner, workspace, "Kept Mirror");
			const group = await newGroup(owner, workspace, "Engineers");
			const person = await newPerson("Person");
			const memberId = await join(person, workspace, owner);
			await narrow(owner, workspace, app, [group]);
			const refused = await authorize(app, person);
			await api("/oauth2/consent", {
				who: person,
				body: { accept: true, oauth_query: refused.location.search.slice(1) },
			});
			await id.auditEventRecorded(person.userId, { type: "refused", app: app.clientId });

			await putIn(owner, workspace, group, memberId);

			const response = await api("/account/activity", { who: person });
			expect(await response.text()).toContain("Kept Mirror");
		});
	});

	describe("what the log keeps", () => {
		async function detailsOf(who: Who, type: string) {
			const response = await api("/account/activity", { who });
			const { events } = (await response.json()) as {
				events: { type: string; detail: string | null }[];
			};
			return events
				.filter((event) => event.type === type)
				.map((event) => JSON.parse(event.detail ?? "{}"));
		}

		it("says what an app's list became, and who it was opened to", async () => {
			const { owner, workspace, app, group } = await aNarrowedApp();
			await vi.waitFor(async () => {
				expect(await detailsOf(owner, "app_groups_changed")).toEqual([
					expect.objectContaining({ groups: [group.name], name: app.name }),
				]);
			});

			expect((await setGroups(owner, workspace, app, [])).status).toBe(200);
			await vi.waitFor(async () => {
				const [latest] = await detailsOf(owner, "app_groups_changed");
				expect(latest.groups).toEqual([]);
			});
		});

		it("says what a group was called", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const group = await newGroup(owner, workspace, "Sales");
			await api("/workspaces/groups/rename", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id, name: "Growth" },
			});
			await vi.waitFor(async () => {
				expect(await detailsOf(owner, "group_renamed")).toEqual([
					expect.objectContaining({ group: "Growth", was: "Sales" }),
				]);
			});
		});
	});

	describe("the claim", () => {
		// What every other test here leaves to the provider, which setting the list replaces.
		it("leaves what discovery says of other claims as it was", () => {
			expect(as.claims_supported).toEqual(
				expect.arrayContaining(["sub", "email", "email_verified", "name", "picture"]),
			);
			expect(as.claims_parameter_supported).toBe(false);
		});

		const ASKING = { scope: "openid groups offline_access" };

		async function signInAsking(app: App, person: Who, params: Record<string, string> = ASKING) {
			return exchange(app, await agree(await authorize(app, person, params), person));
		}

		async function userinfoOf(accessToken: string | undefined) {
			const response = await userinfo(accessToken);
			expect(response.status).toBe(200);
			return (await response.json()) as Record<string, unknown>;
		}

		it("tells an app that asks, in the ID token and at userinfo, by name and in order", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aWorkspace();
			const second = await newGroup(owner, workspace, "Designers");
			await putIn(owner, workspace, second, insideId);

			const { tokens, claims } = await signInAsking(app, inside);

			expect(claims.groups).toEqual([second.name, group.name]);
			expect((await userinfoOf(tokens.access_token)).groups).toEqual([second.name, group.name]);
		});

		it("says someone is in none, rather than leaving it to be guessed", async () => {
			const { app, outside } = await aWorkspace();
			const { tokens, claims } = await signInAsking(app, outside);
			expect(claims.groups).toEqual([]);
			expect((await userinfoOf(tokens.access_token)).groups).toEqual([]);
		});

		it("tells an app that does not ask nothing", async () => {
			const { app, inside } = await aWorkspace();
			const { tokens, claims } = await signInToApp(app, inside);
			expect(claims).not.toHaveProperty("groups");
			expect(await userinfoOf(tokens.access_token)).not.toHaveProperty("groups");
		});

		it("tells each app only its own workspace's, for someone in two", async () => {
			const { app, group, inside } = await aWorkspace();
			const theirOwner = await newPerson("Other owner");
			const theirs = await newWorkspace(theirOwner, "Theirs");
			const theirApp = await newApp(theirOwner, theirs);
			const theirGroup = await newGroup(theirOwner, theirs, "From the other one");
			const theirId = await join(inside, theirs, theirOwner);
			await putIn(theirOwner, theirs, theirGroup, theirId);

			const here = await signInAsking(app, inside);
			const there = await signInAsking(theirApp, inside);

			expect(here.claims.groups).toEqual([group.name]);
			expect((await userinfoOf(here.tokens.access_token)).groups).toEqual([group.name]);
			expect(there.claims.groups).toEqual([theirGroup.name]);
			expect((await userinfoOf(there.tokens.access_token)).groups).toEqual([theirGroup.name]);
		});

		it("tells an app of the groups that do not open it as well, as the page says", async () => {
			const { owner, workspace, app, group, inside, insideId } = await aWorkspace();
			const other = await newGroup(owner, workspace, "Other");
			await putIn(owner, workspace, other, insideId);
			await narrow(owner, workspace, app, [group]);
			const { claims } = await signInAsking(app, inside);
			expect(claims.groups).toEqual([group.name, other.name].sort());
		});

		it("follows a change, on refresh and at userinfo", async () => {
			const { owner, workspace, app, group, inside } = await aWorkspace();
			const { tokens, claims } = await signInAsking(app, inside);
			expect(claims.groups).toEqual([group.name]);

			const renamed = await api("/workspaces/groups/rename", {
				who: owner,
				body: { organizationId: workspace.id, groupId: group.id, name: "Renamed" },
			});
			expect(renamed.status).toBe(200);

			expect((await userinfoOf(tokens.access_token)).groups).toEqual(["Renamed"]);
			const refreshed = await refresh(app, tokens.refresh_token);
			expect(oauth.getValidatedIdTokenClaims(refreshed)?.groups).toEqual(["Renamed"]);
		});

		it("asks someone again when an app comes to want it", async () => {
			const { app, inside } = await aWorkspace();
			const { tokens } = await signInToApp(app, inside);
			const asked = await authorize(app, inside, ASKING);
			expect(asked.location.pathname).toBe("/consent");
			expect(asked.location.searchParams.get("scope")).toContain("groups");
			await exchange(app, await agree(asked, inside));
			// What they say now replaces what they said, as for any list of scopes.
			expect((await userinfo(tokens.access_token)).status).toBe(401);
		});

		it("is not offered to a first-party app, which belongs to no workspace", async () => {
			const person = await newPerson();
			const first = await firstPartyApp();
			const client = {
				clientId: first.clientId,
				redirectUri: `https://first-party-${hosts}.apps.test/callback`,
			};
			const refused = await authorize(client, person, { scope: "openid groups" });
			expect(refused.location.searchParams.has("code")).toBe(false);
			expect(refused.location.searchParams.get("error")).toBe("invalid_scope");
			expect(JSON.parse(String((await appRowIn(first.clientId))?.scopes))).not.toContain("groups");
		});

		it("is on the row of a workspace's app", async () => {
			const { app } = await aWorkspace();
			expect(JSON.parse(String((await appRowIn(app.clientId))?.scopes))).toContain("groups");
		});

		it("is in discovery", () => {
			expect(as.scopes_supported).toContain("groups");
			expect(as.claims_supported).toContain("groups");
		});

		it("leaves other claims as they were", async () => {
			const { app, inside } = await aWorkspace();
			const { claims } = await signInAsking(app, inside, { scope: "openid email groups" });
			expect(claims).toMatchObject({ email: inside.email, email_verified: true });
			expect(claims).not.toHaveProperty("name");
		});
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
			expect(await seen.json()).toMatchObject({ apps: [], groups: [], appsEnabled: false });

			const group = await post(
				"/workspaces/groups/create",
				{ organizationId, name: "Sales" },
				cookie,
			);
			expect(group.status).toBe(404);

			const allowed = await plain.fetch(`${origin}/api/auth/account/allowed-apps`, {
				headers: { origin, "cf-connecting-ip": newClient(), cookie },
			});
			expect(allowed.status).toBe(404);
		} finally {
			await plain.dispose();
		}
	});
});
