import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_FROM, type SentEmail, startId } from "./id-worker";

// Sign-in, through the public routes of the built Worker, with email on as a deployment's is.

const origin = "https://id.test";

const CODE_EMAIL = "is your Gateweave ID code";
const EXISTS_EMAIL = "You already have a Gateweave ID account";
const RESET_EMAIL = "Reset your Gateweave ID password";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each person comes from an address of their own, so rate limits stay out of the way. */
function newClient() {
	return `203.0.113.${++clients}`;
}

/** Calls Better Auth as the app's own pages do. */
function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
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

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

/** Email is sent after the response, so wait for it to arrive. */
async function emailTo(address: string, subject: string, count = 1): Promise<SentEmail> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const found = (await id.emails()).filter(
			(sent) => sent.to === address && sent.subject.includes(subject),
		);
		if (found.length >= count) return found[count - 1] as SentEmail;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No email to ${address} about "${subject}"`);
}

function linkIn(email: SentEmail, path: string): string {
	const link = new RegExp(`https://id\\.test/api/auth/${path}\\S+`).exec(email.text)?.[0];
	if (!link) throw new Error(`No ${path} link in: ${email.text}`);
	return link;
}

function codeIn(email: SentEmail): string {
	const code = /\b\d{6}\b/.exec(email.text)?.[0];
	if (!code) throw new Error(`No code in: ${email.text}`);
	return code;
}

function requestCode(client: string, email: string) {
	return authApi("/email-otp/send-verification-otp", {
		client,
		body: { email, type: "sign-in" },
	});
}

function enterCode(client: string, email: string, otp: string, name = "A Person") {
	return authApi("/sign-in/email-otp", { client, body: { email, otp, name } });
}

async function session(client: string, cookie: string) {
	const response = await authApi("/get-session", { client, cookie });
	expect(response.status).toBe(200);
	return (await response.json()) as { user: { email: string; emailVerified: boolean } } | null;
}

async function accountCount(email: string) {
	const row = await id.db
		.prepare("SELECT COUNT(*) AS count FROM user WHERE email = ?")
		.bind(email)
		.first<{ count: number }>();
	return row?.count;
}

/** Signs someone up with the code sent to them, without a password. Returns their cookie. */
async function signUp(client: string, name: string, email: string) {
	expect((await requestCode(client, email)).status).toBe(200);
	const mail = await emailTo(email, CODE_EMAIL);
	const signedUp = await enterCode(client, email, codeIn(mail), name);
	expect(signedUp.status).toBe(200);
	return cookieOf(signedUp);
}

/** Signs someone up and has them choose a password. Returns their cookie. */
async function accountWithPassword(client: string, name: string, email: string, password: string) {
	const cookie = await signUp(client, name, email);
	const set = await authApi("/account/first-password", {
		client,
		cookie,
		body: { newPassword: password },
	});
	expect(set.status).toBe(200);
	return cookie;
}

it("renders the home page", async () => {
	const response = await id.fetch(`${origin}/`);
	expect(response.status).toBe(200);
	const html = await response.text();
	expect(html).toContain("Gateweave ID");
	expect(html).toContain("Sign in");
	expect(id.outbound).toEqual([]);
});

it("sends people who are not signed in from the account page to the sign-in page", async () => {
	const response = await id.fetch(`${origin}/account`);
	expect(response.status).toBeGreaterThanOrEqual(300);
	expect(response.status).toBeLessThan(400);
	expect(response.headers.get("location")).toContain("/login");
});

describe("signing up", () => {
	it("creates a verified account from the code, then takes a password", async () => {
		const client = newClient();
		const email = "maya@example.com";

		const asked = await requestCode(client, email);
		expect(asked.status).toBe(200);
		// Asking for a code proves nothing yet: no row, no session.
		expect(cookieOf(asked)).toBe("");
		const mail = await emailTo(email, CODE_EMAIL);
		expect(mail.from).toEqual(EMAIL_FROM);
		expect(await accountCount(email)).toBe(0);

		const signedUp = await enterCode(client, email, codeIn(mail), "Maya Chen");
		expect(signedUp.status).toBe(200);
		const cookie = cookieOf(signedUp);
		expect(await session(client, cookie)).toMatchObject({ user: { email, emailVerified: true } });

		// The welcome page asks for a password, since this account has none.
		const welcome = await id.fetch(`${origin}/welcome`, { headers: { cookie } });
		expect(welcome.status).toBe(200);
		expect(await welcome.text()).toContain(email);

		const set = await authApi("/account/first-password", {
			client,
			cookie,
			body: { newPassword: "a-long-password" },
		});
		expect(set.status).toBe(200);

		// With one, it moves on.
		const again = await id.fetch(`${origin}/welcome`, { headers: { cookie } });
		expect(again.status).toBeGreaterThanOrEqual(300);
		expect(again.status).toBeLessThan(400);

		// The account page greets them.
		const page = await id.fetch(`${origin}/account`, { headers: { cookie } });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Maya Chen");
		expect(html).toContain(email);

		const signedIn = await authApi("/sign-in/email", {
			client,
			body: { email, password: "a-long-password" },
		});
		expect(signedIn.status).toBe(200);
		const passwordCookie = cookieOf(signedIn);
		expect(await session(client, passwordCookie)).toMatchObject({ user: { email } });

		const signedOut = await authApi("/sign-out", {
			client,
			cookie: passwordCookie,
			body: {},
		});
		expect(signedOut.status).toBe(200);
		// The session ends on the server, so the cookie a browser failed to drop is worthless too.
		expect(await session(client, passwordCookie)).toBeNull();
		expect(id.outbound).toEqual([]);
	});

	it("takes no password before the address is proven", async () => {
		const email = "stranger-target@example.com";
		const response = await authApi("/sign-up/email", {
			client: newClient(),
			body: { name: "A Stranger", email, password: "the-strangers-password" },
		});
		expect(response.status).toBe(404);
		expect(await accountCount(email)).toBe(0);
		expect((await id.emails()).filter((sent) => sent.to === email)).toEqual([]);
	});

	it.each([
		"/send-verification-email",
		"/verify-email",
		"/email-otp/check-verification-otp",
		"/email-otp/verify-email",
		"/email-otp/request-password-reset",
		"/forget-password/email-otp",
		"/email-otp/reset-password",
		"/email-otp/request-email-change",
		"/email-otp/change-email",
	])("does not offer %s", async (path) => {
		const response = await authApi(path, { client: newClient(), body: {} });
		expect(response.status).toBe(404);
	});

	it("sends a code for nothing but signing up", async () => {
		const email = "wrong-type@example.com";
		const response = await authApi("/email-otp/send-verification-otp", {
			client: newClient(),
			body: { email, type: "forget-password" },
		});
		expect(response.status).toBe(400);
		expect((await id.emails()).filter((sent) => sent.to === email)).toEqual([]);
	});

	it("needs a name", async () => {
		const client = newClient();
		const email = "nameless@example.com";
		await requestCode(client, email);
		const mail = await emailTo(email, CODE_EMAIL);

		for (const name of ["   ", "x".repeat(101)]) {
			const response = await enterCode(client, email, codeIn(mail), name);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "INVALID_NAME" });
		}
		expect(await accountCount(email)).toBe(0);
	});

	it("uses a code once", async () => {
		const client = newClient();
		const email = "once@example.com";
		await requestCode(client, email);
		const code = codeIn(await emailTo(email, CODE_EMAIL));
		expect((await enterCode(client, email, code)).status).toBe(200);

		// By now the address has an account, so this is refused twice over. Deleting the account
		// leaves only the code's own single use to refuse it.
		await id.db.prepare("DELETE FROM user WHERE email = ?").bind(email).run();
		const again = await enterCode(newClient(), email, code);
		expect(again.status).toBe(400);
		expect(cookieOf(again)).toBe("");
		expect(await accountCount(email)).toBe(0);
	});

	it("gives up on a code after three wrong tries", async () => {
		const email = "guesser-target@example.com";
		await requestCode(newClient(), email);
		const code = codeIn(await emailTo(email, CODE_EMAIL));
		const wrong = code === "000000" ? "111111" : "000000";

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await enterCode(newClient(), email, wrong);
			expect(response.status).toBe(400);
		}
		const right = await enterCode(newClient(), email, code);
		expect(right.status).toBe(400);
		expect(cookieOf(right)).toBe("");
		expect(await accountCount(email)).toBe(0);
	});

	it("does not let another code replace one once an address has had its share", async () => {
		const email = "capped@example.com";
		for (let sent = 1; sent <= 5; sent++) {
			expect((await requestCode(newClient(), email)).status).toBe(200);
			await emailTo(email, CODE_EMAIL, sent);
		}
		const last = codeIn(await emailTo(email, CODE_EMAIL, 5));

		// Over the cap the answer is the same, but nothing is stored: a rotated code would reset the
		// attempts and make the code above stop working.
		const over = await requestCode(newClient(), email);
		expect(over.status).toBe(200);
		expect(await over.json()).toEqual({ success: true });

		const signedUp = await enterCode(newClient(), email, last);
		expect(signedUp.status).toBe(200);
	});
});

describe("an address that already has an account", () => {
	it("is told so by email, with no code, and the answer looks the same", async () => {
		const client = newClient();
		const email = "existing@example.com";
		await signUp(client, "Existing", email);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const codes = (await id.emails()).filter((sent) => sent.to === email).length;

		const unknown = await requestCode(newClient(), "not-yet@example.com");
		const known = await requestCode(newClient(), email);
		expect(known.status).toBe(unknown.status);
		expect(await known.json()).toEqual(await unknown.json());

		const mail = await emailTo(email, EXISTS_EMAIL);
		expect(mail.text).toContain(`${origin}/login?email=existing%40example.com`);
		expect(mail.text).toContain(`${origin}/forgot-password?email=existing%40example.com`);
		expect(mail.text).not.toMatch(/\b\d{6}\b/);
		expect((await id.emails()).filter((sent) => sent.to === email).length).toBe(codes + 1);
	});

	it("cannot be signed in to with a code, even a right one", async () => {
		const email = "race@example.com";
		await requestCode(newClient(), email);
		const code = codeIn(await emailTo(email, CODE_EMAIL));

		// An account appears while the code is still good, as a GitHub sign-in would make one.
		await id.db
			.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
			)
			.bind("race-user", "Race", email, Date.now(), Date.now())
			.run();

		const refused = await enterCode(newClient(), email, code);
		expect(refused.status).toBe(400);
		expect(cookieOf(refused)).toBe("");
		const sessions = await id.db
			.prepare("SELECT COUNT(*) AS count FROM session WHERE user_id = ?")
			.bind("race-user")
			.first<{ count: number }>();
		expect(sessions?.count).toBe(0);
	});

	it("is refused a code in the same words as a stranger's wrong one", async () => {
		const client = newClient();
		const existing = "words-existing@example.com";
		await signUp(client, "Words", existing);

		const fresh = "words-fresh@example.com";
		await requestCode(newClient(), fresh);
		const code = codeIn(await emailTo(fresh, CODE_EMAIL));
		const wrong = code === "000000" ? "111111" : "000000";

		const answers = [];
		// The fourth try at a fresh address is where "too many attempts" would show.
		for (let attempt = 0; attempt < 4; attempt++) {
			const forFresh = await enterCode(newClient(), fresh, wrong);
			const forExisting = await enterCode(newClient(), existing, wrong);
			answers.push([
				forFresh.status,
				await forFresh.json(),
				forExisting.status,
				await forExisting.json(),
			]);
		}
		for (const [freshStatus, freshBody, existingStatus, existingBody] of answers) {
			expect(existingStatus).toBe(freshStatus);
			expect(existingBody).toEqual(freshBody);
		}
	});
});

describe("a password", () => {
	it("is refused when wrong", async () => {
		const client = newClient();
		await accountWithPassword(client, "Sam Ortiz", "sam@example.com", "the-right-password");

		const response = await authApi("/sign-in/email", {
			client,
			body: { email: "sam@example.com", password: "the-wrong-password" },
		});
		expect(response.status).toBe(401);
		expect(cookieOf(response)).toBe("");
	});

	it("is set once, and only for someone signed in", async () => {
		const client = newClient();
		const cookie = await accountWithPassword(client, "Lena Park", "lena@example.com", "first-one");

		const second = await authApi("/account/first-password", {
			client,
			cookie,
			body: { newPassword: "second-one-here" },
		});
		expect(second.status).toBe(400);
		const stillFirst = await authApi("/sign-in/email", {
			client,
			body: { email: "lena@example.com", password: "first-one" },
		});
		expect(stillFirst.status).toBe(200);

		const anonymous = await authApi("/account/first-password", {
			client: newClient(),
			body: { newPassword: "a-long-password" },
		});
		expect(anonymous.status).toBe(401);
	});

	it("is not set on a session that is no longer recent", async () => {
		const client = newClient();
		const email = "stale@example.com";
		const cookie = await signUp(client, "Stale", email);
		await id.db
			.prepare(
				"UPDATE session SET created_at = ?, updated_at = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)",
			)
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, Date.now() - 2 * 24 * 60 * 60 * 1000, email)
			.run();

		const response = await authApi("/account/first-password", {
			client,
			cookie,
			body: { newPassword: "a-long-password" },
		});
		expect(response.status).toBe(403);
	});

	it("can be reset once, which signs out every session", async () => {
		const client = newClient();
		const email = "diego@example.com";
		const oldSession = await accountWithPassword(client, "Diego Ruiz", email, "the-old-password");

		// Someone without an account gets the same answer, and no email.
		for (const address of ["nobody@example.com", email]) {
			const response = await authApi("/request-password-reset", {
				client,
				body: { email: address, redirectTo: "/reset-password" },
			});
			expect(response.status).toBe(200);
		}
		const mail = await emailTo(email, RESET_EMAIL);
		expect((await id.emails()).filter((sent) => sent.to === "nobody@example.com")).toEqual([]);

		// The link checks the token and hands it to the app's page.
		const opened = await id.fetch(linkIn(mail, "reset-password"), {
			headers: { "cf-connecting-ip": client },
		});
		expect(opened.status).toBe(302);
		const token = new URL(opened.headers.get("location") ?? "", origin).searchParams.get("token");
		if (!token) throw new Error("No token in the redirect");

		const reset = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "the-new-password" },
		});
		expect(reset.status).toBe(200);
		expect(await session(client, oldSession)).toBeNull();

		const withNew = await authApi("/sign-in/email", {
			client,
			body: { email, password: "the-new-password" },
		});
		expect(withNew.status).toBe(200);
		const withOld = await authApi("/sign-in/email", {
			client,
			body: { email, password: "the-old-password" },
		});
		expect(withOld.status).toBe(401);

		// A link works once.
		const again = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "another-password" },
		});
		expect(again.status).toBe(400);
	});

	it("comes from a reset for someone who left before choosing one", async () => {
		const client = newClient();
		const email = "left-early@example.com";
		await signUp(client, "Left Early", email);

		await authApi("/request-password-reset", {
			client,
			body: { email, redirectTo: "/reset-password" },
		});
		const opened = await id.fetch(linkIn(await emailTo(email, RESET_EMAIL), "reset-password"), {
			headers: { "cf-connecting-ip": client },
		});
		const token = new URL(opened.headers.get("location") ?? "", origin).searchParams.get("token");
		if (!token) throw new Error("No token in the redirect");
		const reset = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "a-long-password" },
		});
		expect(reset.status).toBe(200);

		const signedIn = await authApi("/sign-in/email", {
			client,
			body: { email, password: "a-long-password" },
		});
		expect(signedIn.status).toBe(200);
	});
});

describe("the account's name", () => {
	it("cannot be set to nothing or to something very long", async () => {
		const client = newClient();
		const cookie = await signUp(client, "Named", "named@example.com");
		for (const name of ["   ", "x".repeat(101)]) {
			const response = await authApi("/update-user", { client, cookie, body: { name } });
			expect(response.status).toBe(400);
		}
		const renamed = await authApi("/update-user", { client, cookie, body: { name: "New Name" } });
		expect(renamed.status).toBe(200);
	});
});

describe("without email", () => {
	it("has no sign-up by code, and does not pretend to", async () => {
		const bare = await startId("https://bare.test", { email: false });
		try {
			const response = await bare.fetch(
				"https://bare.test/api/auth/email-otp/send-verification-otp",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://bare.test",
						"cf-connecting-ip": newClient(),
					},
					body: JSON.stringify({ email: "solo@example.com", type: "sign-in" }),
				},
			);
			expect(response.status).toBe(404);
			expect(await bare.emails()).toEqual([]);

			const page = await bare.fetch("https://bare.test/signup");
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("does not send email");
		} finally {
			await bare.dispose();
		}
	});
});
