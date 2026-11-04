import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appRow, CLIENT_SECRET_PREFIX, insertStatement, problemWithRedirectUri } from "./app-row";

const app = { app: "track", name: "Track", redirectUris: ["https://track.example.com/callback"] };

describe("appRow", () => {
	it("keeps a hash of the secret, without its prefix, and hands out the secret itself", () => {
		const { row, clientSecret } = appRow(app);
		expect(clientSecret.startsWith(CLIENT_SECRET_PREFIX)).toBe(true);
		const secret = clientSecret.slice(CLIENT_SECRET_PREFIX.length);
		expect(row.client_secret).toBe(createHash("sha256").update(secret).digest("base64url"));
		expect(JSON.stringify(row)).not.toContain(secret);
	});

	it("makes a new id and secret every time", () => {
		const first = appRow(app);
		const second = appRow(app);
		expect(first.clientId).not.toBe(second.clientId);
		expect(first.clientSecret).not.toBe(second.clientSecret);
	});

	it("names the app, which the check for who may sign in goes by", () => {
		expect(JSON.parse(appRow(app).row.metadata)).toEqual({ app: "track" });
	});

	it("gives every app pairwise subjects and PKCE", () => {
		const { row } = appRow(app);
		expect(row.subject_type).toBe("pairwise");
		expect(row.require_pkce).toBe(1);
	});
});

describe("insertStatement", () => {
	it("escapes what could end a string", () => {
		const { row } = appRow({ ...app, name: "Ada's'); DROP TABLE user; --" });
		expect(insertStatement(row)).toContain("'Ada''s''); DROP TABLE user; --'");
	});
});

describe("problemWithRedirectUri", () => {
	it.each([
		"https://track.example.com/callback",
		"http://localhost:4710/callback",
		"http://127.0.0.1:4710/callback",
	])("accepts %s", (uri) => {
		expect(problemWithRedirectUri(uri)).toBeUndefined();
	});

	it.each([
		"not a url",
		"http://track.example.com/callback",
		"http://localhost.example.com/callback",
		"https://track.example.com/callback#fragment",
		"javascript:alert(1)",
	])("refuses %s", (uri) => {
		expect(problemWithRedirectUri(uri)).toBeTruthy();
	});
});
