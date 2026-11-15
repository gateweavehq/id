import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it } from "vitest";
import { withSignInMethod } from "./session-method";

/** As much of a request as the hook reads: the path that is making a session, and its parameters. */
function made(path: string, params?: Record<string, string>) {
	return { path, params, context: {} } as unknown as GenericEndpointContext;
}

async function methodAt(path: string, params?: Record<string, string>) {
	const { data } = await withSignInMethod({ userId: "someone" }, made(path, params));
	return data.signInMethod;
}

describe("how a session being made says it was made", () => {
	it("names the provider that signed someone in", async () => {
		expect(await methodAt("/callback/:id", { id: "github" })).toBe("github");
	});

	it.each(["passkey", "totp", "recovery_code"])(
		"says nothing for a provider called %s, which would pass for two factors",
		async (provider) => {
			expect(await methodAt("/callback/:id", { id: provider })).toBeNull();
		},
	);

	it("says nothing for a callback that names no provider, or a path nobody decided about", async () => {
		expect(await methodAt("/callback/:id")).toBeNull();
		expect(await methodAt("/somewhere-new")).toBeNull();
		expect((await withSignInMethod({ userId: "someone" }, null)).data.signInMethod).toBeNull();
	});

	it("replaces what the session was given, which a plugin copies from the one before", async () => {
		const copied = { userId: "someone", signInMethod: "passkey" };
		const { data } = await withSignInMethod(copied, made("/callback/:id", { id: "github" }));
		expect(data.signInMethod).toBe("github");
	});
});
