import { describe, expect, it } from "vitest";
import { accountExistsEmail, passwordResetEmail, signUpCodeEmail } from "./templates";

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

describe("signUpCodeEmail", () => {
	it("shows the code in every part and says how long it works", () => {
		const email = signUpCodeEmail({ code: "123456", minutes: 10, email: "a@example.com" });
		expect(email.subject).toBe("123456 is your Gateweave ID code");
		expect(email.text).toContain("123456");
		expect(email.text).toContain("10 minutes");
		expect(email.html).toContain("123456");
	});

	it("says which address the account is for, safely", () => {
		const email = signUpCodeEmail({ code: "123456", minutes: 10, email: "a<b>@example.com" });
		expect(email.text).toContain("a<b>@example.com");
		expect(email.html).toContain("a&lt;b&gt;@example.com");
	});
});

describe("accountExistsEmail", () => {
	it("offers signing in and a new password, and no code", () => {
		const signInUrl = "https://id.example.com/login?email=a%40b.c";
		const resetUrl = "https://id.example.com/forgot-password?email=a%40b.c";
		const email = accountExistsEmail({ signInUrl, resetUrl });
		expect(email.subject).toBe("You already have a Gateweave ID account");
		expect(email.text).toContain(signInUrl);
		expect(email.text).toContain(resetUrl);
		expect(email.html).toContain(`href="${signInUrl}"`);
		expect(email.text).not.toMatch(/\b\d{6}\b/);
	});
});
