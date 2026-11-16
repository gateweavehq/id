import { describe, expect, it } from "vitest";
import { nothingHappened, passkeyFailure } from "./passkey-errors";

/** As the plugin's client hands a failure over. */
function failure(error: { code?: string; message?: string }) {
	return passkeyFailure(error);
}

describe("passkeyFailure", () => {
	it("says what an authenticator that already holds one means", () => {
		expect(
			failure({
				code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
				message: "Previously registered",
			}),
		).toBe("This device already has a passkey for this account.");
	});

	it("keeps the server's words where it has none of its own", () => {
		expect(failure({ code: "LAST_WAY_TO_SIGN_IN", message: "This is your only way." })).toBe(
			"This is your only way.",
		);
		expect(failure({})).toBe("Something went wrong");
	});

	it("does not take an authenticator that already holds one for someone changing their mind", () => {
		expect(nothingHappened({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toBe(false);
		expect(nothingHappened({ code: "ERROR_CEREMONY_ABORTED" })).toBe(true);
	});
});
