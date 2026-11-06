import * as oauth from "oauth4webapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { type SentEmail, startId } from "./id-worker";

// Deleting an account, through the public routes of the built Worker. Each refusal is tried on someone
// it should stop, and then on the same person once what stopped them has gone, because a refusal that
// never lets anyone through proves as little as one that never stops anyone.

const origin = "https://id.test";
const issuer = new URL(origin);
const PASSWORD = "a-long-password-for-tests";

let id: Awaited<ReturnType<typeof startId>>;
/** The first account owns the server, so that nobody else in this file does by accident. */
let runsTheServer: Person;

beforeAll(async () => {
	id = await startId(origin);
	runsTheServer = await newPerson();
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

function newClient() {
	const n = ++clients;
	return `198.51.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

interface Who {
	cookie: string;
	client?: string;
}

function api(path: string, init: { who?: Who; body?: object; client?: string } = {}) {
	const { who, body, client } = init;
	return id.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": client ?? who?.client ?? newClient(),
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

async function emailTo(address: string, like: RegExp): Promise<SentEmail> {
	return vi.waitFor(
		async () => {
			const sent = (await id.emails()).filter((message) => message.to === address);
			const found = sent.findLast((message) => like.test(message.text));
			if (!found) throw new Error(`Nothing like ${like} reached ${address}`);
			return found;
		},
		{ timeout: 5_000 },
	);
}

let people = 0;

function newAddress() {
	return `leaving-${++people}@example.com`;
}

/** Someone who has proved an address with a code, and chosen no password. */
async function newPersonWithNoPassword(email = newAddress()) {
	const client = newClient();
	const before = (await id.emails()).filter((message) => message.to === email).length;
	await api("/email-otp/send-verification-otp", { client, body: { email, type: "sign-in" } });
	const { text } = await vi.waitFor(
		async () => {
			const sent = (await id.emails()).filter((message) => message.to === email);
			const latest = sent[before];
			if (!latest) throw new Error(`No code reached ${email}`);
			return latest;
		},
		{ timeout: 5_000 },
	);
	const otp = /\b\d{6}\b/.exec(text)?.[0];
	const entered = await api("/sign-in/email-otp", { client, body: { email, otp, name: "Ada" } });
	expect(entered.status).toBe(200);
	const cookie = cookieOf(entered);
	const { user } = (await entered.json()) as { user: { id: string } };
	return { email, client, cookie, userId: user.id };
}

type Person = Awaited<ReturnType<typeof newPersonWithNoPassword>>;

async function newPerson(email = newAddress()): Promise<Person> {
	const person = await newPersonWithNoPassword(email);
	const set = await api("/account/first-password", {
		who: person,
		body: { newPassword: PASSWORD },
	});
	expect(set.status).toBe(200);
	return person;
}

/** From an address of its own each time, except where the limit is what is being tried. */
function deleteAccount(who: Who, body: object = { password: PASSWORD }) {
	return api("/account/delete", { who, client: newClient(), body });
}

async function codeOf(response: Response) {
	return ((await response.json()) as { code: string }).code;
}

async function isSignedIn(who: Who) {
	return (await (await api("/get-session", { who })).json()) !== null;
}

function rowsOf(table: string, column: string, value: string) {
	return id.db
		.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
		.bind(value)
		.first<number>("n");
}

async function hasAccount(person: Person) {
	return (await rowsOf("user", "id", person.userId)) === 1;
}

let slugs = 0;

async function newWorkspace(owner: Who, name = "Acme") {
	const slug = `leaving-workspace-${++slugs}`;
	const response = await api("/organization/create", { who: owner, body: { name, slug } });
	expect(response.status).toBe(200);
	const { id: workspaceId } = (await response.json()) as { id: string };
	return { id: workspaceId, slug, name };
}

type Workspace = Awaited<ReturnType<typeof newWorkspace>>;

async function membersOf(who: Who, workspace: Workspace) {
	const response = await api(`/workspaces/get?slug=${workspace.slug}`, { who });
	expect(response.status).toBe(200);
	return (await response.json()) as {
		you: { memberId: string };
		members: { email: string; role: string }[];
	};
}

/** Brings someone in, by the invitation a real member would get. */
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
	return (await membersOf(person, workspace)).you.memberId;
}

describe("deleting an account", () => {
	it("takes the account, each way in and each session", async () => {
		const person = await newPerson();
		const elsewhere = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(elsewhere.status).toBe(200);
		const secondDevice = { cookie: cookieOf(elsewhere) };
		expect(await isSignedIn(secondDevice)).toBe(true);

		const deleted = await deleteAccount(person);
		expect(deleted.status).toBe(200);
		expect(await deleted.clone().json()).toEqual({ deleted: true });
		expect(deleted.headers.get("cache-control")).toContain("no-store");
		// The browser's own cookie goes, so that it does not keep asking with a dead one.
		expect(deleted.headers.getSetCookie().some((cookie) => /max-age=0/i.test(cookie))).toBe(true);

		expect(await isSignedIn(person)).toBe(false);
		expect(await isSignedIn(secondDevice)).toBe(false);
		for (const [table, column] of [
			["user", "id"],
			["session", "user_id"],
			["account", "user_id"],
			["member", "user_id"],
		] as const) {
			expect(await rowsOf(table, column, person.userId), table).toBe(0);
		}

		const again = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(401);
	});

	it("tells the address", async () => {
		const person = await newPerson();
		expect((await deleteAccount(person)).status).toBe(200);
		const { subject, text } = await emailTo(person.email, /has been deleted/);
		expect(subject).toBe("Your Gateweave ID account was deleted");
		expect(text).toContain(person.email);
	});

	it("writes down that it happened, keeping no name or address", async () => {
		const person = await newPerson();
		expect((await deleteAccount(person)).status).toBe(200);
		const row = await vi.waitFor(
			async () => {
				const found = await id.db
					.prepare("SELECT * FROM audit_event WHERE type = 'account_deleted' AND user_id = ?")
					.bind(person.userId)
					.first<Record<string, unknown>>();
				if (!found) throw new Error("Nothing written yet");
				return found;
			},
			{ timeout: 5_000 },
		);
		expect(JSON.stringify(row)).not.toContain(person.email);
		expect(JSON.stringify(row)).not.toContain("Ada");
	});

	it("leaves the address free for a new account, which starts from nothing", async () => {
		const person = await newPerson();
		const workspace = await newWorkspace(runsTheServer);
		await join(person, workspace, runsTheServer);
		expect((await deleteAccount(person)).status).toBe(200);

		const again = await newPersonWithNoPassword(person.email);
		expect(again.userId).not.toBe(person.userId);
		expect((await api(`/workspaces/get?slug=${workspace.slug}`, { who: again })).status).toBe(404);
		expect(await isSignedIn(person)).toBe(false);
	});

	it("leaves Better Auth's own way closed", async () => {
		const person = await newPerson();
		const posted = await api("/delete-user", { who: person, body: { password: PASSWORD } });
		expect(posted.status).toBe(404);
		const linked = await api("/delete-user/callback?token=anything", { who: person });
		expect(linked.status).toBe(404);
		expect(await hasAccount(person)).toBe(true);
		expect(await isSignedIn(person)).toBe(true);
	});
});

describe("what it takes", () => {
	it("needs a session", async () => {
		const response = await api("/account/delete", { body: { password: PASSWORD } });
		expect(response.status).toBe(401);
	});

	it("asks for the password of an account that has one", async () => {
		const person = await newPerson();
		for (const body of [{}, { password: "not-the-right-password" }, { password: "" }]) {
			const refused = await deleteAccount(person, body);
			expect(refused.status, JSON.stringify(body)).toBe(400);
			expect(await codeOf(refused)).toBe("INVALID_PASSWORD");
		}
		expect(await hasAccount(person)).toBe(true);
		expect(await isSignedIn(person)).toBe(true);

		expect((await deleteAccount(person)).status).toBe(200);
		expect(await hasAccount(person)).toBe(false);
	});

	it("takes the word of a recent session where there is no password to ask for", async () => {
		const person = await newPersonWithNoPassword();
		expect((await deleteAccount(person, {})).status).toBe(200);
		expect(await hasAccount(person)).toBe(false);
	});

	it("wants a recent session, even with the right password", async () => {
		const person = await newPerson();
		const twoDaysAgo = Date.now() - 2 * 86_400_000;
		await id.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(twoDaysAgo, person.userId)
			.run();

		const refused = await deleteAccount(person);
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("SESSION_NOT_FRESH");
		expect(await hasAccount(person)).toBe(true);

		const signedInAgain = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedInAgain.status).toBe(200);
		expect((await deleteAccount({ cookie: cookieOf(signedInAgain) })).status).toBe(200);
	});

	it("reads only what it asks for", async () => {
		const person = await newPerson();
		const refused = await deleteAccount(person, { password: PASSWORD, userId: "someone-else" });
		expect(refused.status).toBe(400);
		expect(await hasAccount(person)).toBe(true);
	});

	it("does not let a stolen cookie go on guessing a password", async () => {
		const person = await newPerson();
		const client = newClient();
		const tries = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			const body = { password: `guess-number-${attempt}` };
			tries.push((await api("/account/delete", { who: person, client, body })).status);
		}
		expect(tries).toEqual([400, 400, 400, 400, 400, 429]);
		const right = await api("/account/delete", {
			who: person,
			client,
			body: { password: PASSWORD },
		});
		expect(right.status).toBe(429);
		expect(await hasAccount(person)).toBe(true);
	});
});

describe("who has to stay", () => {
	it("stops a workspace's only owner until each one is seen to, naming them", async () => {
		const owner = await newPerson();
		const other = await newPerson();
		const kept = await newWorkspace(owner, "Zebra Tools");
		const dropped = await newWorkspace(owner, "Acme Labs");
		const otherMember = await join(other, kept, owner, "admin");

		const refused = await deleteAccount(owner);
		expect(refused.status).toBe(403);
		const { code, message } = (await refused.json()) as { code: string; message: string };
		expect(code).toBe("ONLY_OWNER_OF_WORKSPACES");
		expect(message).toContain("Acme Labs, Zebra Tools");
		expect(await hasAccount(owner)).toBe(true);
		expect(await isSignedIn(owner)).toBe(true);

		const promoted = await api("/organization/update-member-role", {
			who: owner,
			body: { organizationId: kept.id, memberId: otherMember, role: "owner" },
		});
		expect(promoted.status).toBe(200);
		const stillOne = await deleteAccount(owner);
		expect(stillOne.status).toBe(403);
		const { message: second } = (await stillOne.json()) as { message: string };
		expect(second).toContain("Acme Labs");
		expect(second).not.toContain("Zebra Tools");

		const gone = await api("/organization/delete", {
			who: owner,
			body: { organizationId: dropped.id },
		});
		expect(gone.status).toBe(200);

		expect((await deleteAccount(owner)).status).toBe(200);
		const { members } = await membersOf(other, kept);
		expect(members.map(({ email }) => email)).toEqual([other.email]);
	});

	it("stops the only owner of a workspace with nobody else in it", async () => {
		const owner = await newPerson();
		await newWorkspace(owner, "Alone");
		const refused = await deleteAccount(owner);
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("ONLY_OWNER_OF_WORKSPACES");
		expect(await hasAccount(owner)).toBe(true);
	});

	it("lets go one of two owners", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const secondMember = await join(second, workspace, first, "admin");
		const promoted = await api("/organization/update-member-role", {
			who: first,
			body: { organizationId: workspace.id, memberId: secondMember, role: "owner" },
		});
		expect(promoted.status).toBe(200);
		expect((await deleteAccount(first)).status).toBe(200);

		const { members } = await membersOf(second, workspace);
		expect(members).toEqual([expect.objectContaining({ email: second.email, role: "owner" })]);
	});

	it("stops whoever runs the server until someone else does", async () => {
		const successor = await newPerson();
		const refused = await deleteAccount(runsTheServer);
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("RUNS_THE_SERVER");
		expect(await hasAccount(runsTheServer)).toBe(true);
		expect(await isSignedIn(runsTheServer)).toBe(true);

		await id.db
			.prepare("UPDATE deployment SET owner_id = ? WHERE id = 1")
			.bind(successor.userId)
			.run();
		try {
			const refusedNow = await deleteAccount(successor);
			expect(await codeOf(refusedNow)).toBe("RUNS_THE_SERVER");
		} finally {
			await id.db
				.prepare("UPDATE deployment SET owner_id = ? WHERE id = 1")
				.bind(runsTheServer.userId)
				.run();
		}
		expect((await deleteAccount(successor)).status).toBe(200);
	});
});

describe("what a workspace keeps", () => {
	it("keeps an app and a group, and says who left", async () => {
		const owner = await newPerson();
		const admin = await newPerson();
		const workspace = await newWorkspace(owner);
		const adminMember = await join(admin, workspace, owner, "admin");

		const added = await api("/workspaces/apps/add", {
			who: admin,
			body: {
				organizationId: workspace.id,
				name: "Their Tool",
				redirectUris: ["https://their-tool.apps.test/callback"],
			},
		});
		expect(added.status).toBe(200);
		const { clientId } = (await added.json()) as { clientId: string };

		const made = await api("/workspaces/groups/create", {
			who: owner,
			body: { organizationId: workspace.id, name: "Engineers" },
		});
		expect(made.status).toBe(200);
		const { id: groupId } = (await made.json()) as { id: string };
		const grouped = await api("/workspaces/groups/add-member", {
			who: owner,
			body: { organizationId: workspace.id, groupId, memberId: adminMember },
		});
		expect(grouped.status).toBe(200);

		const invited = await api("/organization/invite-member", {
			who: admin,
			body: { organizationId: workspace.id, email: newAddress(), role: "member" },
		});
		expect(invited.status).toBe(200);
		const { id: invitationId } = (await invited.json()) as { id: string };

		expect((await deleteAccount(admin)).status).toBe(200);

		const app = await id.db
			.prepare("SELECT added_by AS addedBy FROM oauth_client WHERE client_id = ?")
			.bind(clientId)
			.first<{ addedBy: string }>();
		expect(app?.addedBy).toBe(admin.userId);
		expect(await rowsOf("workspace_group", "id", groupId)).toBe(1);
		expect(await rowsOf("workspace_group_member", "group_id", groupId)).toBe(0);
		// The one thing that goes with them. It says so on the page.
		expect(await rowsOf("invitation", "id", invitationId)).toBe(0);

		const left = await vi.waitFor(
			async () => {
				const found = await id.db
					.prepare(
						"SELECT detail FROM audit_event WHERE type = 'member_left' AND user_id = ? AND workspace_id = ?",
					)
					.bind(admin.userId, workspace.id)
					.first<{ detail: string }>();
				if (!found) throw new Error("Nothing written yet");
				return found;
			},
			{ timeout: 5_000 },
		);
		expect(JSON.parse(left.detail)).toEqual({ workspace: workspace.name });
	});
});

describe("apps someone signed in to", () => {
	const fromApp = {
		[oauth.customFetch]: ((input, init) =>
			id.fetch(input as string, {
				...init,
				headers: {
					...Object.fromEntries(new Headers(init?.headers)),
					"cf-connecting-ip": "198.51.100.1",
				},
			})) satisfies typeof fetch,
	};
	let apps = 0;

	async function signInToApp(person: Person) {
		const as = await oauth.processDiscoveryResponse(
			issuer,
			await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...fromApp }),
		);
		const host = `leaving-app-${++apps}.apps.test`;
		const redirectUri = `https://${host}/callback`;
		const made = appRow({
			app: `leaving-app-${apps}`,
			name: `Leaving App ${apps}`,
			redirectUris: [redirectUri],
			backchannelLogoutUri: `https://${host}/logout`,
		});
		await id.db.prepare(insertStatement(made.row)).run();
		const client = { client_id: made.clientId } satisfies oauth.Client;
		const auth = oauth.ClientSecretBasic(made.clientSecret);

		const state = oauth.generateRandomState();
		const nonce = oauth.generateRandomNonce();
		const verifier = oauth.generateRandomCodeVerifier();
		const url = new URL(as.authorization_endpoint ?? "");
		url.search = new URLSearchParams({
			client_id: made.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid profile email offline_access",
			state,
			nonce,
			code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
			code_challenge_method: "S256",
		}).toString();
		const answered = await id.fetch(url, {
			headers: { "cf-connecting-ip": person.client, cookie: person.cookie },
		});
		const { url: told } =
			answered.status === 200 ? ((await answered.clone().json()) as { url: string }) : { url: "" };
		const location = new URL(answered.headers.get("location") ?? told, origin);
		const params = oauth.validateAuthResponse(as, client, location, state);
		const exchanged = await oauth.authorizationCodeGrantRequest(
			as,
			client,
			auth,
			params,
			redirectUri,
			verifier,
			fromApp,
		);
		const tokens = await oauth.processAuthorizationCodeResponse(as, client, exchanged, {
			expectedNonce: nonce,
			requireIdToken: true,
		});
		const claims = oauth.getValidatedIdTokenClaims(tokens);
		return { as, client, auth, tokens, claims, clientId: made.clientId, host };
	}

	it("tells them the session ended, and takes back what they held", async () => {
		const person = await newPerson();
		const app = await signInToApp(person);
		expect(await rowsOf("oauth_refresh_token", "client_id", app.clientId)).toBe(1);

		expect((await deleteAccount(person)).status).toBe(200);

		const logoutUri = `https://${app.host}/logout`;
		const delivered = await vi.waitFor(
			() => {
				const found = id.outboundBodies.find(({ url }) => url === logoutUri);
				if (!found) throw new Error("Nothing delivered yet");
				return found;
			},
			{ timeout: 5_000 },
		);
		const token = new URLSearchParams(delivered.body).get("logout_token") ?? "";
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
		expect(payload).toMatchObject({ iss: origin, aud: app.clientId, sub: app.claims?.sub });

		expect(await rowsOf("oauth_access_token", "client_id", app.clientId)).toBe(0);
		expect(await rowsOf("oauth_refresh_token", "client_id", app.clientId)).toBe(0);
		const refreshed = await oauth.refreshTokenGrantRequest(
			app.as,
			app.client,
			app.auth,
			app.tokens.refresh_token ?? "",
			fromApp,
		);
		expect(refreshed.status).not.toBe(200);
	});
});
