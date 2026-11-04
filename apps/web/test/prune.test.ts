import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
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

async function has(table: "session" | "verification", rowId: string) {
	const row = await id.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first();
	return row !== null;
}

describe("the daily cron", () => {
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
