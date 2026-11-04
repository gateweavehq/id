import { afterAll, beforeAll, expect, it } from "vitest";
import { startId } from "./id-worker";

// Better Auth turns its limiter on only when NODE_ENV is "production", which a Worker never sets,
// so a deployed app took unlimited password guesses. Once on, it counted in each isolate's
// memory, so every isolate gave an attacker a fresh allowance.

const origin = "https://id.test";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { isolates: 2 });
});

afterAll(async () => {
	await id?.dispose();
});

async function signIn(headers: Record<string, string>, isolate = 0) {
	const response = await id.fetchIn(isolate, `${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...headers },
		body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
	});
	return response.status;
}

it("limits sign-in attempts from one client", async () => {
	const client = { "cf-connecting-ip": "203.0.113.7" };
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signIn(client));
	expect(statuses).toEqual([401, 401, 401, 429]);

	expect(await signIn({ "cf-connecting-ip": "203.0.113.8" })).toBe(401);
});

it("tells clients apart by the address Cloudflare saw, not one they claim", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({
				"cf-connecting-ip": "198.51.100.20",
				"x-forwarded-for": `192.0.2.${attempt + 1}`,
			}),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});

it("counts a client's attempts in every isolate together", async () => {
	const client = { "cf-connecting-ip": "203.0.113.30" };
	const statuses = [];
	for (const isolate of [0, 1, 0, 1]) statuses.push(await signIn(client, isolate));
	expect(statuses).toEqual([401, 401, 401, 429]);
	// Had the Durable Object failed, each isolate would have fallen back to its own count.
	expect(id.logs.filter((log) => log.message.startsWith("rate limit:"))).toEqual([]);
});
