import { describe, expect, it } from "vitest";
import { scopeWords } from "./allowed-app";

describe("scopeWords", () => {
	it("says what each scope lets an app have, and nothing for the one every sign-in has", () => {
		expect(scopeWords(["openid", "profile", "email", "offline_access"])).toEqual([
			"See your name and picture",
			"See your email address",
			"Keep you signed in while you are away",
		]);
	});

	it("has no words for what it has not heard of, however it is named", () => {
		expect(scopeWords(["constructor", "__proto__", "toString", ""])).toEqual([]);
	});
});
