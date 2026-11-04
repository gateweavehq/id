import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId, TURNSTILE_SITE_KEY, TURNSTILE_TOKENS } from "./id-worker";

// What the built Worker sends a browser. These are the headers that stop a stolen page from being
// scripted or framed, and the bot check in front of the paths bots go for.

const origin = "https://id.test";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

function nonceOf(policy: string | null): string {
	const nonce = /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
	if (!nonce) throw new Error(`No nonce in: ${policy}`);
	return nonce;
}

/** Every script tag in a page, as the opening tag. */
function scriptTags(html: string): string[] {
	return html.match(/<script\b[^>]*>/gi) ?? [];
}

/** The code in the email an address was sent, once it has gone out after the response. */
async function codeSentTo(worker: typeof id, email: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await worker.emails()).find((message) => message.to === email);
		const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (code) return code;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No code reached ${email}`);
}

describe("a page", () => {
	it("cannot be framed or sniffed, and is not cached", async () => {
		const response = await id.fetch(`${origin}/login`);
		expect(response.status).toBe(200);
		const policy = response.headers.get("content-security-policy");
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).toContain("default-src 'none'");
		expect(policy).toContain("base-uri 'none'");
		expect(policy).toContain("frame-src 'none'");
		expect(policy).not.toContain("challenges.cloudflare.com");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
	});

	it.each(["/", "/login", "/signup", "/forgot-password", "/does-not-exist"])(
		"lets every script of %s run, because each one has this response's nonce",
		async (path) => {
			const response = await id.fetch(`${origin}${path}`);
			const nonce = nonceOf(response.headers.get("content-security-policy"));
			const html = await response.text();
			const tags = scriptTags(html);
			expect(tags.length).toBeGreaterThan(0);
			for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
			// The router reads it back from here in the browser.
			expect(html).toContain(`property="csp-nonce" content="${nonce}"`);
		},
	);

	it("gets a nonce of its own every time", async () => {
		const first = await id.fetch(`${origin}/login`);
		const second = await id.fetch(`${origin}/login`);
		expect(nonceOf(first.headers.get("content-security-policy"))).not.toBe(
			nonceOf(second.headers.get("content-security-policy")),
		);
	});
});

describe("an API answer", () => {
	it("gets the headers that apply to it, and no policy for pages", async () => {
		const response = await id.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
		expect(response.headers.get("content-security-policy")).toBeNull();
	});
});

describe("the session cookie", () => {
	it("stays on this host, out of reach of scripts and other sites", async () => {
		const email = "cookie@example.com";
		const headers = {
			origin,
			"content-type": "application/json",
			"cf-connecting-ip": "203.0.113.200",
		};
		await id.fetch(`${origin}/api/auth/email-otp/send-verification-otp`, {
			method: "POST",
			headers,
			body: JSON.stringify({ email, type: "sign-in" }),
		});
		const otp = await codeSentTo(id, email);
		const response = await id.fetch(`${origin}/api/auth/sign-in/email-otp`, {
			method: "POST",
			headers,
			body: JSON.stringify({ email, otp, name: "Ada" }),
		});
		expect(response.status).toBe(200);

		const cookie = response.headers.getSetCookie().find((one) => one.includes("session_token"));
		expect(cookie).toBeDefined();
		expect(cookie?.toLowerCase()).not.toContain("domain=");
		expect(cookie?.toLowerCase()).toContain("httponly");
		expect(cookie?.toLowerCase()).toContain("secure");
		expect(cookie?.toLowerCase()).toContain("samesite=lax");
	});
});

describe("with Turnstile on", () => {
	const turnstileOrigin = "https://turnstile.test";
	let guarded: Awaited<ReturnType<typeof startId>>;
	let clients = 0;

	beforeAll(async () => {
		guarded = await startId(turnstileOrigin, { turnstile: true });
	});

	afterAll(async () => {
		await guarded?.dispose();
	});

	function post(path: string, body: object, token?: string) {
		return guarded.fetch(`${turnstileOrigin}/api/auth${path}`, {
			method: "POST",
			headers: {
				origin: turnstileOrigin,
				"content-type": "application/json",
				"cf-connecting-ip": `198.51.100.${++clients}`,
				...(token && { "x-captcha-response": token }),
			},
			body: JSON.stringify(body),
		});
	}

	function sendCode(email: string, token?: string) {
		return post("/email-otp/send-verification-otp", { email, type: "sign-in" }, token);
	}

	async function emailCount(email: string) {
		return (await guarded.emails()).filter((sent) => sent.to === email).length;
	}

	it("allows the widget on pages, and tells them the site key", async () => {
		const response = await guarded.fetch(`${turnstileOrigin}/signup`);
		const policy = response.headers.get("content-security-policy");
		expect(policy).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
		expect(policy).toContain("frame-src https://challenges.cloudflare.com");
		expect(await response.text()).toContain(TURNSTILE_SITE_KEY);
	});

	it.each([
		["no token", undefined, 400],
		["a refused token", TURNSTILE_TOKENS.refused, 403],
		["a token for something else", TURNSTILE_TOKENS.otherAction, 403],
		["a token from another site", TURNSTILE_TOKENS.otherHost, 403],
		["Siteverify being down", TURNSTILE_TOKENS.unavailable, 500],
	])("sends no code on %s", async (_case, token, status) => {
		const email = `refused-${token ?? "none"}@example.com`;
		const response = await sendCode(email, token);
		expect(response.status).toBe(status);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await emailCount(email)).toBe(0);
	});

	it("sends a code on a good token", async () => {
		const email = "human@example.com";
		const response = await sendCode(email, TURNSTILE_TOKENS.good);
		expect(response.status).toBe(200);
		expect(await codeSentTo(guarded, email)).toMatch(/^\d{6}$/);
	});

	it("guards password sign-in and password reset as well", async () => {
		const signIn = { email: "nobody@example.com", password: "a-long-password" };
		expect((await post("/sign-in/email", signIn)).status).toBe(400);
		expect((await post("/sign-in/email", signIn, TURNSTILE_TOKENS.good)).status).toBe(401);

		const reset = { email: "nobody@example.com", redirectTo: "/reset-password" };
		expect((await post("/request-password-reset", reset)).status).toBe(400);
		expect((await post("/request-password-reset", reset, TURNSTILE_TOKENS.good)).status).toBe(200);
	});

	it("does not ask for it again when the code comes back", async () => {
		const email = "entering-the-code@example.com";
		await sendCode(email, TURNSTILE_TOKENS.good);
		const otp = await codeSentTo(guarded, email);

		const response = await post("/sign-in/email-otp", { email, otp, name: "Ada" });
		expect(response.status).toBe(200);
	});

	it("does not ask for it where there is nothing to guess", async () => {
		const response = await guarded.fetch(`${turnstileOrigin}/api/auth/get-session`, {
			headers: { origin: turnstileOrigin },
		});
		expect(response.status).toBe(200);
	});
});
