import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId } from "./id-worker";

// BETTER_AUTH_URL is optional until the provider is on, and without it Better Auth decides on
// `Secure` from NODE_ENV, which a Worker never has. A browser would then send the session cookie
// over plain HTTP, such as on the first request to a custom domain.

type Id = Awaited<ReturnType<typeof startId>>;

async function codeSentTo(worker: Id, email: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const sent = (await worker.emails()).find((message) => message.to === email);
		const code = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (code) return code;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`no code reached ${email}`);
}

async function signUp(worker: Id, origin: string) {
	const email = "sam@example.com";
	const headers = {
		origin,
		"content-type": "application/json",
		"cf-connecting-ip": "203.0.113.201",
	};
	await worker.fetch(`${origin}/api/auth/email-otp/send-verification-otp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, type: "sign-in" }),
	});
	const otp = await codeSentTo(worker, email);
	return worker.fetch(`${origin}/api/auth/sign-in/email-otp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, otp, name: "Sam" }),
	});
}

describe("a deployment with no BETTER_AUTH_URL", () => {
	const origin = "https://id.test";
	let id: Id;

	beforeAll(async () => {
		id = await startId(origin, { pinned: false, oidc: false });
	});
	afterAll(() => id.dispose());

	it("marks its cookies Secure and keeps their names, so nobody is signed out", async () => {
		const response = await signUp(id, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure/i);
	});
});

describe("a build pinned to localhost over plain HTTP", () => {
	const origin = "http://localhost:4731";
	let id: Id;

	beforeAll(async () => {
		id = await startId(origin, { oidc: false });
	});
	afterAll(() => id.dispose());

	it("leaves Secure off, as Better Auth does for a plain HTTP address", async () => {
		const response = await signUp(id, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*Secure/i);
	});
});
