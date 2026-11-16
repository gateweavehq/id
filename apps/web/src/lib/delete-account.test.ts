import { describe, expect, it } from "vitest";
import { onlyOwnerWords } from "./delete-account";

describe("onlyOwnerWords", () => {
	it("does not say each of one workspace", () => {
		expect(onlyOwnerWords(["Only Mine"])).toBe(
			"You are the only owner of Only Mine. Make someone else an owner, or delete it, first.",
		);
	});

	it("says each of several", () => {
		expect(onlyOwnerWords(["Acme Labs", "Zebra Tools"])).toBe(
			"You are the only owner of Acme Labs, Zebra Tools. Make someone else an owner of each, or delete it, first.",
		);
	});
});
