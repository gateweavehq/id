import { describe, expect, it } from "vitest";
import { countedByWhoSentIt, isAWorkersAddress } from "./workers-address";

const WORKERS = "2a06:98c0:3600::103";

async function countedAs(headers: Record<string, string>) {
	const request = new Request("https://id.test/api/auth/oauth2/token", { headers });
	return (await countedByWhoSentIt(request)).headers.get("cf-connecting-ip");
}

describe("countedByWhoSentIt", () => {
	it("counts Workers on different zones apart", async () => {
		const one = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		const other = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "example.com" });
		expect(one).not.toBe(other);
		expect(one).not.toBe(WORKERS);
	});

	it("counts Workers on one zone together, however its name is written", async () => {
		const one = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		const again = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "GateWeave.com" });
		expect(one).toBe(again);
	});

	it("makes an address Better Auth takes, which differs within its first 64 bits", async () => {
		const made = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		expect(made).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}::1$/);
	});

	it("leaves everyone else as they are, whatever they claim", async () => {
		const someone = { "cf-connecting-ip": "203.0.113.7", "cf-worker": "gateweave.com" };
		expect(await countedAs(someone)).toBe("203.0.113.7");
	});

	it("gives the request itself back for anyone else, body and all", async () => {
		const request = new Request("https://id.test/", { method: "POST", body: "a" });
		expect(await countedByWhoSentIt(request)).toBe(request);
	});

	it("counts by the address when there is no zone to count by", async () => {
		expect(await countedAs({ "cf-connecting-ip": WORKERS })).toBe(WORKERS);
	});

	it("keeps a Worker's request's method and body", async () => {
		const request = new Request("https://id.test/", {
			method: "POST",
			headers: { "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" },
			body: "grant_type=refresh_token",
		});
		const counted = await countedByWhoSentIt(request);
		expect(counted.method).toBe("POST");
		expect(await counted.text()).toBe("grant_type=refresh_token");
	});
});

describe("isAWorkersAddress", () => {
	it("knows Cloudflare's address and the ones made here", async () => {
		const made = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		expect(isAWorkersAddress(WORKERS)).toBe(true);
		expect(isAWorkersAddress(made ?? "")).toBe(true);
	});

	it("takes nobody's own for one", () => {
		for (const address of ["203.0.113.7", "2001:db8::1", "2a06:98c0:3600::104"]) {
			expect(isAWorkersAddress(address), address).toBe(false);
		}
	});
});
