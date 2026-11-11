import { describe, expect, it } from "vitest";
import { signUpWords } from "./sign-up-words";

describe("what the owner's page says about sign-up", () => {
	it("does not offer to open it when nothing could prove an address", () => {
		const words = signUpWords({ signUp: "closed", email: false, github: false });
		expect(words.opening).toBeNull();
		expect(words.now).toContain("Only people you invite");
		expect(words.now).toContain("this server has neither");
	});

	it("says that the list lets people in while it is closed", () => {
		const words = signUpWords({ signUp: "closed", email: true, github: false });
		expect(words.now).toContain("on your list below");
		expect(signUpWords({ signUp: "open", email: true, github: false }).now).not.toContain("list");
	});

	it("says who opening it lets in", () => {
		expect(signUpWords({ signUp: "closed", email: true, github: false }).opening).toContain(
			"Anyone who finds this server",
		);
		expect(signUpWords({ signUp: "closed", email: true, github: true }).opening).toContain(
			"Anyone who finds this server",
		);
		expect(signUpWords({ signUp: "closed", email: false, github: true }).opening).toContain(
			"Anyone with a GitHub account",
		);
	});

	it("does not call an open server open to anyone when nobody can use it", () => {
		const words = signUpWords({ signUp: "open", email: false, github: false });
		expect(words.now).toContain("nobody can use it");
		expect(words.now).not.toContain("Anyone");
	});

	it("says who can make an account on an open server", () => {
		expect(signUpWords({ signUp: "open", email: true, github: false }).now).toContain(
			"Anyone can make an account",
		);
		expect(signUpWords({ signUp: "open", email: false, github: true }).now).toContain(
			"Anyone with a GitHub account",
		);
	});
});
