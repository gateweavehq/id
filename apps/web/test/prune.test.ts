import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { appRow, insertStatement } from "../src/server/auth/app-row";
import { startId } from "./id-worker";

const origin = "https://id.test";
const HOUR = 3_600_000;

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
	await id.db
		.prepare(
			"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
		)
		.bind("someone", "Someone", "someone@example.com", Date.now(), Date.now())
		.run();
});

afterAll(async () => {
	await id?.dispose();
});

function addVerification(rowId: string, expiresAt: number) {
	return id.db
		.prepare(
			"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(rowId, `identifier-${rowId}`, "value", expiresAt, Date.now(), Date.now());
}

function addSession(rowId: string, expiresAt: number) {
	return id.db
		.prepare(
			"INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(rowId, "someone", `token-${rowId}`, expiresAt, Date.now(), Date.now());
}

async function has(
	table:
		| "session"
		| "verification"
		| "oauth_access_token"
		| "oauth_refresh_token"
		| "audit_event"
		| "invitation",
	rowId: string,
) {
	const row = await id.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first();
	return row !== null;
}

describe("the daily cron", () => {
	it("deletes invitations past their time, and the addresses they hold", async () => {
		const addInvitation = (rowId: string, expiresAt: number) =>
			id.db
				.prepare(
					"INSERT INTO invitation (id, organization_id, email, status, expires_at, inviter_id) VALUES (?, 'prunable', ?, 'pending', ?, 'someone')",
				)
				.bind(rowId, `${rowId}@example.com`, expiresAt);
		await id.db.batch([
			id.db.prepare(
				"INSERT INTO organization (id, name, slug, created_at) VALUES ('prunable', 'Prunable', 'prunable', 0)",
			),
			addInvitation("expired-invitation", Date.now() - HOUR),
			addInvitation("live-invitation", Date.now() + HOUR),
		]);
		await id.runCron();
		expect(await has("invitation", "expired-invitation")).toBe(false);
		expect(await has("invitation", "live-invitation")).toBe(true);
	});

	it("deletes expired sessions and leaves live ones", async () => {
		await id.db.batch([
			addSession("expired-session", Date.now() - HOUR),
			addSession("live-session", Date.now() + HOUR),
		]);
		await id.runCron();
		expect(await has("session", "expired-session")).toBe(false);
		expect(await has("session", "live-session")).toBe(true);
	});

	it("deletes expired verifications and leaves live ones", async () => {
		await id.db.batch([
			addVerification("expired-verification", Date.now() - HOUR),
			addVerification("live-verification", Date.now() + HOUR),
		]);
		await id.runCron();
		expect(await has("verification", "expired-verification")).toBe(false);
		expect(await has("verification", "live-verification")).toBe(true);
	});

	it("deletes expired tokens and leaves live ones", async () => {
		const { row, clientId } = appRow({
			app: "an-app",
			name: "An app",
			redirectUris: ["https://an-app.test/callback"],
		});
		const addToken = (
			table: "oauth_access_token" | "oauth_refresh_token",
			rowId: string,
			at: number,
		) =>
			id.db
				.prepare(
					`INSERT INTO ${table} (id, token, client_id, user_id, expires_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(rowId, `token-${rowId}`, clientId, "someone", at, Date.now(), "[]");
		await id.db.batch([
			id.db.prepare(insertStatement(row)),
			addToken("oauth_access_token", "expired-access", Date.now() - HOUR),
			addToken("oauth_access_token", "live-access", Date.now() + HOUR),
			addToken("oauth_refresh_token", "expired-refresh", Date.now() - HOUR),
			addToken("oauth_refresh_token", "live-refresh", Date.now() + HOUR),
		]);
		await id.runCron();
		expect(await has("oauth_access_token", "expired-access")).toBe(false);
		expect(await has("oauth_access_token", "live-access")).toBe(true);
		expect(await has("oauth_refresh_token", "expired-refresh")).toBe(false);
		expect(await has("oauth_refresh_token", "live-refresh")).toBe(true);
	});

	it("deletes audit events past their age, and leaves the rest", async () => {
		const addEvent = (rowId: string, daysAgo: number) =>
			id.db
				.prepare("INSERT INTO audit_event (id, at, type) VALUES (?, ?, 'sign_in')")
				.bind(rowId, Date.now() - daysAgo * 24 * HOUR);
		await id.db.batch([addEvent("too-old", 91), addEvent("old-enough", 89)]);
		await id.runCron();
		expect(await has("audit_event", "too-old")).toBe(false);
		expect(await has("audit_event", "old-enough")).toBe(true);
	});

	it("gets through more than one batch", async () => {
		const expired = Array.from({ length: 2500 }, (_, index) =>
			addVerification(`old-${index}`, Date.now() - HOUR),
		);
		await id.db.batch(expired);
		await id.runCron();
		const left = await id.db
			.prepare("SELECT COUNT(*) AS count FROM verification WHERE id LIKE 'old-%'")
			.first<{ count: number }>();
		expect(left?.count).toBe(0);
	});

	it("logs no error", () => {
		expect(id.logs.filter((log) => log.level === "error")).toEqual([]);
	});
});

describe("the schedule", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");

	// A handler with no schedule never runs, and nothing would say so: the tables just keep growing.
	it.each([
		["a self-hosted deployment", undefined],
		["Gateweave Cloud", "cloud"],
		["staging", "staging"],
	])("runs on %s", (_name, env) => {
		expect(unstable_readConfig({ config, env }).triggers.crons).toEqual(["17 3 * * *"]);
	});
});
