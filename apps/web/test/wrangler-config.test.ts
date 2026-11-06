import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("what a deploy does to settings", () => {
	it("leaves alone what someone set in the dashboard", () => {
		// Wrangler otherwise removes a plain-text variable it does not find in this file, so the next
		// push would quietly turn off Turnstile, email or a server's legal pages.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config }).keep_vars).toBe(true);
	});
});
