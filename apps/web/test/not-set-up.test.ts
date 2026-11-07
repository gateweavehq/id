import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId } from "./id-worker";

// A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run
// safely without the database and the secret. So a deployment missing either says why and serves
// nothing else.

const origin = "https://id.test";

describe.each([
	["no database", { withoutDatabase: true }],
	["no secret", { withoutSecret: true }],
])("a deployment with %s", (_, missing) => {
	let worker: Awaited<ReturnType<typeof startId>>;

	beforeAll(async () => {
		worker = await startId(origin, missing);
	});
	afterAll(() => worker.dispose());

	it.each(["/", "/login", "/api/auth/get-session"])("says why at %s", async (path) => {
		const response = await worker.fetch(`${origin}${path}`);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("docs/self-hosting.md");
	});

	it("makes no account and no session", async () => {
		const response = await worker.fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				name: "Someone",
				email: "someone@example.com",
				password: "a long enough password",
			}),
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("set-cookie")).toBeNull();
	});
});
