import { describe, expect, it } from "vitest";
import { parseSearch, stringifySearch } from "./search";

describe("the query of a page", () => {
	it("keeps what looks like JSON as the text it is", () => {
		expect(parseSearch("?state=1e5&nonce=true&code=007&list=[1]&empty=")).toEqual({
			state: "1e5",
			nonce: "true",
			code: "007",
			list: "[1]",
			empty: "",
		});
	});

	it("keeps every value of a repeated name, in order", () => {
		expect(parseSearch("?ba_param=b&x=1&ba_param=a&ba_param=c")).toEqual({
			ba_param: ["b", "a", "c"],
			x: "1",
		});
	});

	it("comes back the same", () => {
		const query = "?scope=openid+email&state=1e5&ba_param=scope&ba_param=state&sig=a%2Bb%3D";
		expect(stringifySearch(parseSearch(query))).toBe(query);
	});

	it("takes a name that could reach a prototype as any other", () => {
		const parsed = parseSearch("?__proto__=x&constructor=y");
		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(stringifySearch(parsed)).toBe("?__proto__=x&constructor=y");
	});

	it("leaves out what has no value", () => {
		expect(stringifySearch({ email: undefined, redirect: "/account" })).toBe(
			"?redirect=%2Faccount",
		);
		expect(stringifySearch({ email: undefined })).toBe("");
	});
});
