import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	appRow,
	CLIENT_SECRET_PREFIX,
	hostOfUris,
	insertStatement,
	problemWithRedirectUri,
	problemWithWorkspaceAppUris,
	workspaceAppRow,
} from "./app-row";

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

describe("workspaceAppRow", () => {
	const app = {
		workspace: "workspace-1",
		name: "Tool",
		redirectUris: ["https://tool.example.com/callback"],
	};

	it("always asks, and tells apps that do not trust each other nothing to match people by", () => {
		const { row } = workspaceAppRow(app);
		expect(row.skip_consent).toBe(0);
		expect(row.enable_end_session).toBe(0);
		expect(row.backchannel_logout_uri).toBeNull();
		expect(row.post_logout_redirect_uris).toBeNull();
	});

	it("says whose it is in the two places that read it, and its name is its own id", () => {
		const { row, clientId } = workspaceAppRow(app);
		expect(row.reference_id).toBe("workspace-1");
		expect(JSON.parse(row.metadata)).toEqual({ app: clientId, workspace: "workspace-1" });
	});

	it("keeps a hash of the secret, as any app does", () => {
		const { row, clientSecret } = workspaceAppRow(app);
		const secret = clientSecret.slice(CLIENT_SECRET_PREFIX.length);
		expect(row.client_secret).toBe(createHash("sha256").update(secret).digest("base64url"));
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
		"https://me:secret@track.example.com/callback",
	])("refuses %s", (uri) => {
		expect(problemWithRedirectUri(uri)).toBeTruthy();
	});
});

describe("problemWithWorkspaceAppUris", () => {
	const issuer = "https://id.example.com";

	it("accepts one host, more than one path, and this machine for trying it out", () => {
		expect(
			problemWithWorkspaceAppUris(["https://a.example.com/1", "https://a.example.com/2"], issuer),
		).toBeUndefined();
		expect(problemWithWorkspaceAppUris(["http://localhost:3000/callback"], issuer)).toBeUndefined();
	});

	it.each([
		["what any app may not", ["http://a.example.com/callback"]],
		["two hosts", ["https://a.example.com/1", "https://b.example.com/1"]],
		["one host on two ports", ["https://a.example.com/1", "https://a.example.com:8443/1"]],
		["this server", ["https://id.example.com/callback"]],
		["another port of this server", ["https://id.example.com:8443/callback"]],
		["this server after another", ["https://a.example.com/1", "https://id.example.com/1"]],
		["this server with a dot after it", ["https://id.example.com./callback"]],
		["any host with a dot after it", ["https://a.example.com./callback"]],
	])("refuses %s", (_name, uris) => {
		expect(problemWithWorkspaceAppUris(uris, issuer)).toBeTruthy();
	});

	it("on this machine, tells this server from the other programs on it", () => {
		const local = "http://localhost:4732";
		expect(problemWithWorkspaceAppUris(["http://localhost:4732/callback"], local)).toBeTruthy();
		expect(problemWithWorkspaceAppUris(["http://localhost:4733/callback"], local)).toBeUndefined();
	});
});

describe("hostOfUris", () => {
	it("names the host with its port", () => {
		expect(hostOfUris(["https://a.example.com:8443/1"])).toBe("a.example.com:8443");
	});

	it.each([[[]], [null], ["https://a.example.com"], [["not a url"]], [[7]]])(
		"has nothing to say of %j",
		(uris) => {
			expect(hostOfUris(uris)).toBeNull();
		},
	);
});
