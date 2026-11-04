import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_FROM, type SentEmail, startId } from "./id-worker";

// Sign-in, through the public routes of the built Worker, with email on as a deployment's is.

const origin = "https://id.test";

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
			(sent) => sent.to === address && sent.subject === subject,
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

async function signUp(client: string, name: string, email: string, password: string) {
	return authApi("/sign-up/email", {
		client,
		body: { name, email, password, callbackURL: "/account" },
	});
}

async function session(client: string, cookie: string) {
	const response = await authApi("/get-session", { client, cookie });
	expect(response.status).toBe(200);
	return (await response.json()) as { user: { email: string; emailVerified: boolean } } | null;
}

/** Signs someone up and opens the link sent to them. Returns their session's cookie. */
async function verifiedAccount(client: string, name: string, email: string, password: string) {
	expect((await signUp(client, name, email, password)).status).toBe(200);
	const mail = await emailTo(email, "Verify your email for Gateweave ID");
	const opened = await id.fetch(linkIn(mail, "verify-email"), {
		headers: { "cf-connecting-ip": client },
	});
	expect(opened.status).toBe(302);
	return cookieOf(opened);
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

describe("an account", () => {
	it("signs up, verifies the address, signs in, reads the session and signs out", async () => {
		const client = newClient();
		const email = "maya@example.com";
		const signedUp = await signUp(client, "Maya Chen", email, "a-long-password");
		expect(signedUp.status).toBe(200);
		// No session until the address is verified.
		expect(cookieOf(signedUp)).toBe("");

		const mail = await emailTo(email, "Verify your email for Gateweave ID");
		expect(mail.from).toEqual(EMAIL_FROM);

		const opened = await id.fetch(linkIn(mail, "verify-email"), {
			headers: { "cf-connecting-ip": client },
		});
		expect(opened.status).toBe(302);
		expect(new URL(opened.headers.get("location") ?? "", origin).pathname).toBe("/account");
		const verifiedCookie = cookieOf(opened);
		expect(await session(client, verifiedCookie)).toMatchObject({
			user: { email, emailVerified: true },
		});

		// The account page greets the person who verified.
		const page = await id.fetch(`${origin}/account`, { headers: { cookie: verifiedCookie } });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Maya Chen");
		expect(html).toContain(email);

		const signedIn = await authApi("/sign-in/email", {
			client,
			body: { email, password: "a-long-password" },
		});
		expect(signedIn.status).toBe(200);
		const cookie = cookieOf(signedIn);
		expect(await session(client, cookie)).toMatchObject({ user: { email } });

		const signedOut = await authApi("/sign-out", { client, cookie, body: {} });
		expect(signedOut.status).toBe(200);
		// The session ends on the server, so the cookie a browser failed to drop is worthless too.
		expect(await session(client, cookie)).toBeNull();
		expect(id.outbound).toEqual([]);
	});

	it("is refused a wrong password", async () => {
		const client = newClient();
		await verifiedAccount(client, "Sam Ortiz", "sam@example.com", "the-right-password");

		const response = await authApi("/sign-in/email", {
			client,
			body: { email: "sam@example.com", password: "the-wrong-password" },
		});
		expect(response.status).toBe(401);
		expect(cookieOf(response)).toBe("");
	});

	it("cannot sign in before the address is verified, and gets a new link", async () => {
		const client = newClient();
		const email = "lena@example.com";
		expect((await signUp(client, "Lena Park", email, "a-long-password")).status).toBe(200);
		await emailTo(email, "Verify your email for Gateweave ID");

		const refused = await authApi("/sign-in/email", {
			client,
			body: { email, password: "a-long-password" },
		});
		expect(refused.status).toBe(403);
		expect(cookieOf(refused)).toBe("");

		// The refusal sends the link again.
		const again = await emailTo(email, "Verify your email for Gateweave ID", 2);
		expect(linkIn(again, "verify-email")).toContain("token=");
		const row = await id.db
			.prepare("SELECT email_verified AS verified FROM user WHERE email = ?")
			.bind(email)
			.first<{ verified: number }>();
		expect(row?.verified).toBe(0);
	});

	it("resets a forgotten password, once, and signs out every session", async () => {
		const client = newClient();
		const email = "diego@example.com";
		const oldSession = await verifiedAccount(client, "Diego Ruiz", email, "the-old-password");

		// Someone without an account gets the same answer, and no email.
		for (const address of ["nobody@example.com", email]) {
			const response = await authApi("/request-password-reset", {
				client,
				body: { email: address, redirectTo: "/reset-password" },
			});
			expect(response.status).toBe(200);
		}
		const mail = await emailTo(email, "Reset your Gateweave ID password");
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
});

describe("without email", () => {
	it("signs a new account in at once, since no address could be verified", async () => {
		const bare = await startId("https://bare.test", { email: false });
		try {
			const response = await bare.fetch("https://bare.test/api/auth/sign-up/email", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://bare.test",
					"cf-connecting-ip": newClient(),
				},
				body: JSON.stringify({
					name: "Solo",
					email: "solo@example.com",
					password: "a-long-password",
				}),
			});
			expect(response.status).toBe(200);
			expect(cookieOf(response)).not.toBe("");
			expect(await bare.emails()).toEqual([]);
		} finally {
			await bare.dispose();
		}
	});
});
