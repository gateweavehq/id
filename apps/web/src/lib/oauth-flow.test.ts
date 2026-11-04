import { describe, expect, it } from "vitest";
import {
	asksForNewAccount,
	flowSearch,
	inFlow,
	linkExpired,
	onItsWay,
	restartHref,
	welcomeIsDone,
} from "./oauth-flow";

const signed = {
	client_id: "app",
	state: "1e5",
	scope: "openid email",
	exp: "1",
	ba_iat: "2",
	ba_pl: "3",
	ba_param: ["client_id", "state", "scope"],
	sig: "abc",
};

describe("a page on the way to an app", () => {
	it("is known by its signature", () => {
		expect(inFlow(signed)).toBe(true);
		expect(inFlow({ client_id: "app" })).toBe(false);
		// Repeating the name must not make a page think it has one.
		expect(inFlow({ sig: ["a", "b"] })).toBe(false);
	});

	it("takes its signed query along, and not its own message", () => {
		expect(flowSearch({ ...signed, error: "access_denied", email: "a@example.com" })).toEqual(
			signed,
		);
		expect(flowSearch({ redirect: "/account" })).toEqual({});
	});

	it("asks again with the app's request and nothing else", () => {
		const href = restartHref({ ...signed, error: "x", redirect: "/account", email: "e" });
		const url = new URL(href, "https://id.test");
		expect(url.pathname).toBe("/api/auth/oauth2/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "app",
			state: "1e5",
			scope: "openid email",
		});
	});

	it("repeats what the app repeated", () => {
		const url = new URL(restartHref({ acr_values: ["a", "b"] }), "https://id.test");
		expect(url.searchParams.getAll("acr_values")).toEqual(["a", "b"]);
	});

	it("asks no password on the way to an app of anyone with a way to sign in", () => {
		expect(welcomeIsDone(signed, ["github"])).toBe(true);
		expect(welcomeIsDone(signed, ["passkey"])).toBe(true);
		expect(welcomeIsDone(signed, ["credential"])).toBe(true);
		expect(welcomeIsDone(signed, [])).toBe(false);
	});

	it("still offers a password to someone without one who came here themselves", () => {
		expect(welcomeIsDone({}, ["github"])).toBe(false);
		expect(welcomeIsDone({}, ["passkey"])).toBe(false);
		expect(welcomeIsDone({}, [])).toBe(false);
		expect(welcomeIsDone({}, ["credential"])).toBe(true);
	});

	it("knows when the app asked for a new account", () => {
		expect(asksForNewAccount({ prompt: "create" })).toBe(true);
		expect(asksForNewAccount({ prompt: "login create" })).toBe(true);
		expect(asksForNewAccount({ prompt: "login" })).toBe(false);
		expect(asksForNewAccount({})).toBe(false);
	});
});

describe("what a response says", () => {
	it("is on its way only when it says so and says where", () => {
		expect(onItsWay({ redirect: true, url: "/welcome" })).toBe(true);
		expect(onItsWay({ redirect: false, url: undefined })).toBe(false);
		expect(onItsWay({ redirect: true })).toBe(false);
		expect(onItsWay(null)).toBe(false);
	});

	it("has run out only when the provider says the signature is bad", () => {
		expect(linkExpired({ error: "invalid_signature", status: 400 })).toBe(true);
		expect(linkExpired({ error: "invalid_request", status: 400 })).toBe(false);
		expect(linkExpired(null)).toBe(false);
	});
});
