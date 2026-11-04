import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId } from "./id-worker";

// A form submitted before the page's script runs goes out as a GET, with what was typed in the URL,
// where history and logs keep it. So the pages arrive unable to submit. e2e/ presses every one of
// these buttons, which shows they come to life.

const origin = "https://id.test";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin, { github: true });
});

afterAll(async () => {
	await id?.dispose();
});

async function buttonsOf(path: string, type?: string): Promise<string[]> {
	const response = await id.fetch(`${origin}${path}`);
	expect(response.status).toBe(200);
	const tags = (await response.text()).match(/<button\b[^>]*>/g) ?? [];
	return tags.filter((tag) => !type || tag.includes(`type="${type}"`));
}

describe("a page as it arrives", () => {
	it.each(["/login", "/signup", "/forgot-password", "/reset-password?token=anything"])(
		"%s cannot be submitted yet",
		async (path) => {
			const submits = await buttonsOf(path, "submit");
			expect(submits).toHaveLength(1);
			expect(submits[0]).toMatch(/\sdisabled(=|\s|>)/);
		},
	);

	it("has no form on it that could go without its button", async () => {
		for (const path of ["/login", "/signup", "/forgot-password"]) {
			const html = await (await id.fetch(`${origin}${path}`)).text();
			expect(html.match(/<form\b/g) ?? []).toHaveLength(1);
		}
	});

	it("does not offer GitHub until it can go there", async () => {
		const [button] = await buttonsOf("/login");
		expect(button).toMatch(/\sdisabled(=|\s|>)/);
	});
});
