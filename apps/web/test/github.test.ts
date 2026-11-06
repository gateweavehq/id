import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { type GitHubPerson, gitHubCode, startId } from "./id-worker";

// Signing in with GitHub, through the public routes of the built Worker, with a stand-in for GitHub.
// What they protect is in "Signing in with GitHub" in docs/architecture.md.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { github: true });
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;
let gitHubIds = 1000;

function newClient() {
	return `203.0.113.${++clients}`;
}

/** What a browser would send back. A cookie set to nothing has been cleared. */
function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0] ?? "")
		.filter((cookie) => !cookie.endsWith("="))
		.join("; ");
}

function post(path: string, client: string, body: object, cookie?: string) {
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

/** Someone whose address GitHub has verified, unless a test says otherwise. */
function person(overrides: Partial<GitHubPerson> & { address?: string } = {}): GitHubPerson {
	const { address, ...rest } = overrides;
	const number = ++gitHubIds;
	const email = address ?? `github-${number}@example.com`;
	return {
		id: number,
		login: `person-${number}`,
		name: "Grace Hopper",
		emails: [{ email, primary: true, verified: true }],
		...rest,
	};
}

/** Presses "Continue with GitHub". The result is what the browser is told to do next. */
async function start(client: string, body: object = {}) {
	const response = await post("/sign-in/social", client, {
		provider: "github",
		callbackURL: "/account",
		...body,
	});
	expect(response.status).toBe(200);
	const { url } = (await response.json()) as { url: string };
	const asked = new URL(url);
	return { asked, state: asked.searchParams.get("state") ?? "", cookie: cookieOf(response) };
}

/** Comes back from GitHub with these query parameters. */
function comeBack(client: string, query: Record<string, string>, cookie?: string) {
	return id.fetch(`${origin}/api/auth/callback/github?${new URLSearchParams(query)}`, {
		headers: { "cf-connecting-ip": client, ...(cookie && { cookie }) },
	});
}

/** The whole way there and back as this person. */
async function signInAs(someone: GitHubPerson) {
	const client = newClient();
	const { state, cookie } = await start(client);
	const response = await comeBack(client, { code: gitHubCode(someone), state }, cookie);
	return { response, client, location: response.headers.get("location") ?? "" };
}

async function sessionOf(client: string, response: Response) {
	const reply = await id.fetch(`${origin}/api/auth/get-session`, {
		headers: { "cf-connecting-ip": client, cookie: cookieOf(response) },
	});
	return (await reply.json()) as {
		user: { id: string; email: string; name: string; emailVerified: boolean };
	} | null;
}

/** The row `/unlink-account` asks for, which a page gets from the same list. */
async function accountRow(client: string, cookie: string, providerId: string): Promise<string> {
	const reply = await id.fetch(`${origin}/api/auth/list-accounts`, {
		headers: { "cf-connecting-ip": client, cookie },
	});
	const accounts = (await reply.json()) as { id: string; providerId: string }[];
	const account = accounts.find((candidate) => candidate.providerId === providerId);
	if (!account) throw new Error(`no ${providerId} account`);
	return account.id;
}

function userCount(email: string) {
	return id.db
		.prepare("SELECT count(*) AS n FROM user WHERE email = ?")
		.bind(email)
		.first<number>("n");
}

function gitHubAccount(someone: GitHubPerson) {
	return id.db
		.prepare(
			`SELECT user_id, access_token, refresh_token, id_token, scope FROM account
			 WHERE provider_id = 'github' AND account_id = ?`,
		)
		.bind(String(someone.id))
		.first<{
			user_id: string;
			access_token: string | null;
			refresh_token: string | null;
			id_token: string | null;
			scope: string | null;
		}>();
}

/** The first address a person in these tests has. */
function addressOf(someone: GitHubPerson): string {
	const address = someone.emails?.[0]?.email;
	if (!address) throw new Error("This person has no address");
	return address;
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

/** Someone who signed up with a code, and has a password. */
async function signedUpWithCode(email: string) {
	const client = newClient();
	await post("/email-otp/send-verification-otp", client, { email, type: "sign-in" });
	const otp = await codeSentTo(email);
	const entered = await post("/sign-in/email-otp", client, { email, otp, name: "Ada" });
	expect(entered.status).toBe(200);
	const set = await post(
		"/account/first-password",
		client,
		{ newPassword: PASSWORD },
		cookieOf(entered),
	);
	expect(set.status).toBe(200);
	return sessionOf(client, entered);
}

function expectRefused(response: Response, code: string) {
	expect(response.status).toBe(302);
	expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/login");
	expect(new URL(response.headers.get("location") ?? "", origin).searchParams.get("error")).toBe(
		code,
	);
	expect(cookieOf(response)).not.toContain("session_token");
}

describe("what ID asks GitHub for", () => {
	it("asks to read addresses and nothing else", async () => {
		const { asked } = await start(newClient());
		expect(asked.origin + asked.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(asked.searchParams.get("scope")).toBe("user:email");
		expect(asked.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/github`);
		expect(asked.searchParams.get("client_id")).toBe("github-client-for-tests");
	});

	it("keeps none of GitHub's tokens, the first time or later", async () => {
		const someone = person();
		await signInAs(someone);
		await signInAs(someone);
		expect(await gitHubAccount(someone)).toMatchObject({
			access_token: null,
			refresh_token: null,
			id_token: null,
		});
	});

	it("keeps none when an account is linked again", async () => {
		const someone = person();
		const first = await signInAs(someone);
		const again = await post(
			"/link-social",
			first.client,
			{ provider: "github", callbackURL: "/account" },
			cookieOf(first.response),
		);
		expect(again.status).toBe(200);
		const { url } = (await again.json()) as { url: string };
		const state = new URL(url).searchParams.get("state") ?? "";
		const cookie = [cookieOf(first.response), cookieOf(again)].join("; ");
		const back = await comeBack(first.client, { code: gitHubCode(someone), state }, cookie);
		expect(back.headers.get("location")).toBe("/account");
		expect(await gitHubAccount(someone)).toMatchObject({ access_token: null });
	});
});

describe("someone new", () => {
	it("gets a verified account and goes where they were headed", async () => {
		const someone = person();
		const { response, client, location } = await signInAs(someone);
		expect(location).toBe("/account");
		expect(await sessionOf(client, response)).toMatchObject({
			user: { email: addressOf(someone), name: "Grace Hopper", emailVerified: true },
		});
	});

	it("goes by their GitHub username when they have no name there", async () => {
		const someone = person({ name: null });
		const { response, client } = await signInAs(someone);
		expect((await sessionOf(client, response))?.user.name).toBe(someone.login);
	});

	it("gets no account when GitHub has not verified the address", async () => {
		const email = "unverified@example.com";
		const { response } = await signInAs(
			person({ emails: [{ email, primary: true, verified: false }] }),
		);
		expectRefused(response, "EMAIL_NOT_VERIFIED");
		expect(await userCount(email)).toBe(0);
	});

	it("gets no account from a public address GitHub does not list as verified", async () => {
		const email = "public-only@example.com";
		const { response } = await signInAs(
			person({
				email,
				emails: [{ email: "other@example.com", primary: true, verified: true }],
			}),
		);
		expectRefused(response, "EMAIL_NOT_VERIFIED");
		expect(await userCount(email)).toBe(0);
	});

	it("gets no account when GitHub will not say whether a public address is verified", async () => {
		const email = "no-answer@example.com";
		const { response } = await signInAs(person({ email, emails: null }));
		expectRefused(response, "EMAIL_NOT_VERIFIED");
		expect(await userCount(email)).toBe(0);
	});

	it("gets no account when GitHub gives no address at all", async () => {
		const { response } = await signInAs(person({ emails: null }));
		expectRefused(response, "email_not_found");
	});

	it("can add a password, and then sign in with it", async () => {
		const someone = person();
		const { response, client } = await signInAs(someone);
		const set = await post(
			"/account/first-password",
			client,
			{ newPassword: PASSWORD },
			cookieOf(response),
		);
		expect(set.status).toBe(200);
		const signedIn = await post("/sign-in/email", newClient(), {
			email: addressOf(someone),
			password: PASSWORD,
		});
		expect(signedIn.status).toBe(200);
	});
});

describe("the audit log", () => {
	it("records a new account, connecting GitHub and signing in with it, and only once", async () => {
		const someone = person();
		const first = await signInAs(someone);
		const session = await sessionOf(first.client, first.response);
		const userId = session?.user.id ?? "";
		await id.auditEventRecorded(userId, {
			type: "account_created",
			detail: "github",
			ip: first.client,
		});
		await id.auditEventRecorded(userId, {
			type: "provider_linked",
			detail: "github",
			ip: first.client,
		});
		await id.auditEventRecorded(userId, { type: "sign_in", detail: "github", ip: first.client });

		const second = await signInAs(someone);
		await id.auditEventRecorded(userId, { type: "sign_in", detail: "github", ip: second.client });
		const events = await id.auditEvents(userId);
		expect(events.filter(({ type }) => type === "provider_linked").length).toBe(1);
		expect(events.filter(({ type }) => type === "account_created").length).toBe(1);
	});

	it("records disconnecting GitHub", async () => {
		const someone = person();
		const { response, client } = await signInAs(someone);
		const cookie = cookieOf(response);
		const session = await sessionOf(client, response);
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const unlinked = await post(
			"/unlink-account",
			client,
			{ accountId: await accountRow(client, cookie, "github") },
			cookie,
		);
		expect(unlinked.status).toBe(200);
		await id.auditEventRecorded(session?.user.id ?? "", {
			type: "provider_unlinked",
			detail: "github",
			ip: client,
		});
	});

	it("records removing the password, which is not disconnecting a provider", async () => {
		const someone = person();
		const { response, client } = await signInAs(someone);
		const cookie = cookieOf(response);
		const session = await sessionOf(client, response);
		const userId = session?.user.id ?? "";
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const removed = await post(
			"/unlink-account",
			client,
			{ accountId: await accountRow(client, cookie, "credential"), password: PASSWORD },
			cookie,
		);
		expect(removed.status).toBe(200);
		await id.auditEventRecorded(userId, {
			type: "password_changed",
			detail: "removed",
			ip: client,
		});
		const events = await id.auditEvents(userId);
		expect(events.map(({ type }) => type)).not.toContain("provider_unlinked");
	});

	it("will not let a recent cookie take a password away to choose another", async () => {
		const { response, client } = await signInAs(person());
		const cookie = cookieOf(response);
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const accountId = await accountRow(client, cookie, "credential");

		for (const proof of [
			{},
			{ password: "not-the-password" },
			{ password: "" },
			{ password: 42 },
			{ password: "x".repeat(1000) },
		]) {
			const refused = await post("/unlink-account", newClient(), { accountId, ...proof }, cookie);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { code: string }).code).toBe("INVALID_PASSWORD");
		}

		// Removing it was only ever the first step.
		const replaced = await post(
			"/account/first-password",
			newClient(),
			{ newPassword: "a-password-someone-else-chose" },
			cookie,
		);
		expect(replaced.status).toBe(400);
		expect(await accountRow(client, cookie, "credential")).toBe(accountId);

		const nobody = await post("/unlink-account", newClient(), { accountId, password: PASSWORD });
		expect(nobody.status).toBe(401);

		const removed = await post(
			"/unlink-account",
			newClient(),
			{ accountId, password: PASSWORD },
			cookie,
		);
		expect(removed.status).toBe(200);
	});

	it("does not take guesses at a password through removing it", async () => {
		const { response, client } = await signInAs(person());
		const cookie = cookieOf(response);
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const accountId = await accountRow(client, cookie, "credential");

		const answers: number[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			const answer = await post(
				"/unlink-account",
				client,
				{ accountId, password: "not-the-password" },
				cookie,
			);
			answers.push(answer.status);
		}
		expect(answers).toEqual([400, 400, 400, 400, 400, 429]);
	});

	it("asks for no password to disconnect GitHub, which is not one", async () => {
		const { response, client } = await signInAs(person());
		const cookie = cookieOf(response);
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const unlinked = await post(
			"/unlink-account",
			newClient(),
			{ accountId: await accountRow(client, cookie, "github") },
			cookie,
		);
		expect(unlinked.status).toBe(200);
	});

	it("records nothing when an unlink is refused", async () => {
		const someone = person();
		const { response, client } = await signInAs(someone);
		const cookie = cookieOf(response);
		const session = await sessionOf(client, response);
		const refused = await post(
			"/unlink-account",
			client,
			{ accountId: await accountRow(client, cookie, "github") },
			cookie,
		);
		expect(refused.status).toBe(400);
		// A later event that is written after this one was would show it, had there been one.
		await id.auditEventRecorded(session?.user.id ?? "", { type: "sign_in", detail: "github" });
		const events = await id.auditEvents(session?.user.id ?? "");
		expect(events.map(({ type }) => type)).not.toContain("provider_unlinked");
	});
});

describe("deleting an account that also has GitHub", () => {
	it("wants the password, even from someone who tries removing it first", async () => {
		// So that this person is not the first account, which runs the server and has to stay.
		await signInAs(person());
		const someone = person();
		const { response, client } = await signInAs(someone);
		const cookie = cookieOf(response);
		await post("/account/first-password", client, { newPassword: PASSWORD }, cookie);
		const accountId = await accountRow(client, cookie, "credential");

		const removal = await post("/unlink-account", newClient(), { accountId }, cookie);
		expect(removal.status).toBe(400);
		const refused = await post("/account/delete", newClient(), {}, cookie);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { code: string }).code).toBe("INVALID_PASSWORD");

		const deleted = await post("/account/delete", newClient(), { password: PASSWORD }, cookie);
		expect(deleted.status).toBe(200);
		expect(await userCount(someone.emails?.[0]?.email ?? "")).toBe(0);
	});
});

describe("someone who already has an account", () => {
	it("reaches it with a verified address, and keeps their password", async () => {
		const email = "both-ways@example.com";
		const before = await signedUpWithCode(email);
		const someone = person({ address: email });
		const { response, client, location } = await signInAs(someone);
		expect(location).toBe("/account");
		expect((await sessionOf(client, response))?.user.id).toBe(before?.user.id);
		expect(await userCount(email)).toBe(1);
		const signedIn = await post("/sign-in/email", newClient(), { email, password: PASSWORD });
		expect(signedIn.status).toBe(200);
	});

	it("does not reach it with an address GitHub has not verified", async () => {
		const email = "claimed@example.com";
		await signedUpWithCode(email);
		const someone = person({ emails: [{ email, primary: true, verified: false }] });
		const { response } = await signInAs(someone);
		expectRefused(response, "account_not_linked");
		expect(await gitHubAccount(someone)).toBeNull();
	});

	it("stays the same person after changing their address on GitHub", async () => {
		const someone = person();
		const first = await signInAs(someone);
		const before = await sessionOf(first.client, first.response);
		const later = await signInAs({
			...someone,
			emails: [{ email: "new-address@example.com", primary: true, verified: true }],
		});
		const after = await sessionOf(later.client, later.response);
		expect(after?.user.id).toBe(before?.user.id);
		expect(after?.user.email).toBe(addressOf(someone));
	});
});

describe("a sign-in that does not belong to this browser", () => {
	it("is refused without the cookie from where it started", async () => {
		// Sending someone this link would sign them in to the sender's account.
		const client = newClient();
		const { state } = await start(client);
		const response = await comeBack(client, { code: gitHubCode(person()), state });
		expectRefused(response, "state_mismatch");
	});

	it("is refused with a state ID never gave out", async () => {
		const client = newClient();
		const { cookie } = await start(client);
		const response = await comeBack(
			client,
			{ code: gitHubCode(person()), state: "made-up" },
			cookie,
		);
		expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/login");
		expect(cookieOf(response)).not.toContain("session_token");
	});

	it("is refused with no state at all", async () => {
		const response = await comeBack(newClient(), { code: gitHubCode(person()) });
		expectRefused(response, "state_not_found");
	});

	it("cannot be replayed", async () => {
		const client = newClient();
		const { state, cookie } = await start(client);
		const code = gitHubCode(person());
		await comeBack(client, { code, state }, cookie);
		const again = await comeBack(client, { code, state }, cookie);
		expect(new URL(again.headers.get("location") ?? "", origin).pathname).toBe("/login");
		expect(cookieOf(again)).not.toContain("session_token");
	});
});

describe("leaving for somewhere else", () => {
	for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
		it(`refuses another site as ${field}`, async () => {
			const response = await post("/sign-in/social", newClient(), {
				provider: "github",
				callbackURL: "/account",
				[field]: "https://elsewhere.test/",
			});
			expect(response.status).toBe(403);
		});
	}
});

describe("the sign-in page after a refusal", () => {
	async function page(query: string) {
		const response = await id.fetch(`${origin}/login?${query}`);
		expect(response.status).toBe(200);
		return response.text();
	}

	it("says why someone was sent back", async () => {
		expect(await page("error=EMAIL_NOT_VERIFIED")).toContain(
			"GitHub did not give us a verified email address",
		);
		expect(await page("error=access_denied")).toContain("You chose not to sign in with GitHub.");
	});

	it("has plain words for a code it does not know", async () => {
		expect(await page("error=constructor")).toContain("Signing in with GitHub did not work");
	});

	it("shows nothing the link says", async () => {
		const html = await page(
			"error=access_denied&error_description=Call%20this%20number%20to%20recover%20your%20account",
		);
		expect(html).not.toContain("Call this number");
	});

	it("does not give a refusal to someone who has none", async () => {
		const html = await page("");
		expect(html).not.toContain('role="alert"');
	});
});

describe("on the way to an app", () => {
	/** A browser arriving at the authorization endpoint for a new app, which sends it to sign in. */
	async function arriveFromApp(client: string) {
		const redirectUri = `https://github-${++gitHubIds}.apps.test/callback`;
		const app = appRow({ app: "github-test", name: "GitHub Test", redirectUris: [redirectUri] });
		await id.db.prepare(insertStatement(app.row)).run();
		const query = new URLSearchParams({
			client_id: app.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid email",
			state: "state-of-the-app",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		});
		const response = await id.fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
			headers: { "cf-connecting-ip": client },
		});
		const { url } = (await response.json()) as { url: string };
		const signIn = new URL(url, origin);
		expect(signIn.pathname).toBe("/login");
		return { redirectUri, oauthQuery: signIn.search.slice(1) };
	}

	it("comes back with a code, and asks nobody from GitHub for a password", async () => {
		const client = newClient();
		const { redirectUri, oauthQuery } = await arriveFromApp(client);

		const { state, cookie } = await start(client, { oauth_query: oauthQuery });
		const query = new URLSearchParams({ code: gitHubCode(person()), state });
		const { status, location } = await id.navigate(`${origin}/api/auth/callback/github?${query}`, {
			"cf-connecting-ip": client,
			cookie,
		});

		expect(status).toBe(302);
		const back = new URL(location ?? "");
		expect(back.origin + back.pathname).toBe(redirectUri);
		expect(back.searchParams.get("state")).toBe("state-of-the-app");
		expect(back.searchParams.has("code")).toBe(true);
	});

	it("brings a refusal back to a page that can still finish the job", async () => {
		const client = newClient();
		const { oauthQuery } = await arriveFromApp(client);

		const { state, cookie } = await start(client, {
			oauth_query: oauthQuery,
			errorCallbackURL: `/login?${oauthQuery}`,
		});
		const response = await comeBack(client, { error: "access_denied", state }, cookie);

		const back = new URL(response.headers.get("location") ?? "", origin);
		expect(back.pathname).toBe("/login");
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.get("sig")).toBe(new URLSearchParams(oauthQuery).get("sig"));
	});
});
