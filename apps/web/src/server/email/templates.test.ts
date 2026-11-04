import { describe, expect, it } from "vitest";
import { passwordResetEmail, verificationEmail } from "./templates";

describe("passwordResetEmail", () => {
	it("links to the reset and says what happens", () => {
		const url = "https://id.example.com/api/auth/reset-password/token?callbackURL=%2Freset";
		const email = passwordResetEmail({ url });
		expect(email.subject).toBe("Reset your Gateweave ID password");
		expect(email.text).toContain(url);
		expect(email.text).toContain("signs you out on every device");
		expect(email.html).toContain(`href="${url}"`);
	});
});

describe("verificationEmail", () => {
	it("links to the verification and says how long it works", () => {
		const url = "https://id.example.com/api/auth/verify-email?token=t&callbackURL=%2F";
		const email = verificationEmail({ url });
		expect(email.subject).toBe("Verify your email for Gateweave ID");
		expect(email.text).toContain(url);
		expect(email.text).toContain("24 hours");
		expect(email.html).toContain(`href="${url.replace("&", "&amp;")}"`);
	});
});
