import { expect, it } from "vitest";
import { referenceIn } from "./error-reference";

it("finds the reference in a failed query's message", () => {
	expect(referenceIn(new Error("A database query failed (reference 1a2b3c4d)"))).toBe("1a2b3c4d");
});

it("finds it in what the error was caused by, as Better Auth wraps a failed session read", () => {
	const cause = new Error("A database query failed (reference 0f9e8d7c)");
	expect(referenceIn(new Error("Failed to get session", { cause }))).toBe("0f9e8d7c");
});

it("finds none where there is none, and takes nothing else for one", () => {
	expect(referenceIn(new Error("Failed to get session"))).toBeUndefined();
	expect(referenceIn(new Error("see (reference to the docs)"))).toBeUndefined();
	expect(referenceIn("A database query failed (reference 1a2b3c4d)")).toBeUndefined();
	expect(referenceIn(undefined)).toBeUndefined();
});

it("stops looking in a chain of causes that goes round", () => {
	const one = new Error("one");
	const two = new Error("two", { cause: one });
	one.cause = two;
	expect(referenceIn(one)).toBeUndefined();
});
