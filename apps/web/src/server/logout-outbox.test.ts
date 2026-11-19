import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "./db";
import { faulty, migratedD1 } from "./db/faulty-d1";
import { pruneExpired } from "./db/prune";
import { flushLogoutOutbox, OUTBOX_CRON, queueOrStoreLogout, runCron } from "./logout-outbox";

const logout = { clientId: "track", sub: "pairwise-person", sid: "ended-session" };
let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("logout-outbox-test"));
});

afterAll(async () => {
	await dispose?.();
});

async function rows() {
	return createDb(real).select().from(schema.logoutOutbox);
}

async function ageRows(hours: number) {
	await createDb(real)
		.update(schema.logoutOutbox)
		.set({ createdAt: new Date(Date.now() - hours * 3_600_000) })
		.run();
}

describe("logout queue outbox", () => {
	it("keeps a failed queue handoff and sends it on the next cron", async () => {
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error("queue unavailable"))
			.mockResolvedValue(undefined);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await queueOrStoreLogout(createDb(real), { send }, logout, 60);
			expect(await rows()).toHaveLength(1);
			expect(send).toHaveBeenCalledTimes(1);
			await ageRows(1);
			await flushLogoutOutbox(createDb(real), { send });
			expect(send).toHaveBeenCalledTimes(2);
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("still uses the queue if D1 cannot store the handoff", async () => {
		const { database, state } = faulty(real);
		state.only = /^insert into "logout_outbox"/i;
		state.failures = 1;
		const send = vi.fn().mockResolvedValue(undefined);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await queueOrStoreLogout(createDb(database), { send }, logout, 60);
			expect(send).toHaveBeenCalledOnce();
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("keeps a row when the recovery cron also finds the queue unavailable", async () => {
		const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await queueOrStoreLogout(createDb(real), { send }, logout, 60);
			await ageRows(1);
			await flushLogoutOutbox(createDb(real), { send });
			expect(send).toHaveBeenCalledTimes(2);
			expect(await rows()).toHaveLength(1);
			send.mockResolvedValue(undefined);
			await flushLogoutOutbox(createDb(real), { send });
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("reports failure when neither D1 nor the queue can retain the logout", async () => {
		const { database, state } = faulty(real);
		state.only = /^insert into "logout_outbox"/i;
		state.failures = 1;
		const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(queueOrStoreLogout(createDb(database), { send }, logout, 60)).rejects.toThrow(
				"queue unavailable",
			);
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("retains a row after queue acceptance if its deletion fails, making a later duplicate safe", async () => {
		const { database, state } = faulty(real);
		state.only = /^delete from "logout_outbox"/i;
		state.failures = 1;
		const send = vi.fn().mockResolvedValue(undefined);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await queueOrStoreLogout(createDb(database), { send }, logout, 60);
			expect(await rows()).toHaveLength(1);
			await ageRows(1);
			await flushLogoutOutbox(createDb(real), { send });
			expect(send).toHaveBeenCalledTimes(2);
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("removes an accepted request handoff before the recovery cron can see it", async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		await queueOrStoreLogout(createDb(real), { send }, logout, 60);
		expect(await rows()).toHaveLength(0);
		await flushLogoutOutbox(createDb(real), { send });
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not retry a fresh row while the request may still be sending", async () => {
		const send = vi.fn().mockRejectedValueOnce(new Error("queue unavailable"));
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await queueOrStoreLogout(createDb(real), { send }, logout, 60);
			await flushLogoutOutbox(createDb(real), { send });
			expect(send).toHaveBeenCalledOnce();
			expect(await rows()).toHaveLength(1);
			await ageRows(1);
			await flushLogoutOutbox(createDb(real), { send });
			expect(send).toHaveBeenCalledTimes(2);
			expect(await rows()).toHaveLength(0);
		} finally {
			warned.mockRestore();
		}
	});

	it("continues to younger rows when one queue handoff is refused", async () => {
		const db = createDb(real);
		await db
			.insert(schema.logoutOutbox)
			.values([
				{ id: "refused", ...logout, createdAt: new Date(Date.now() - 7_200_000) },
				{
					id: "accepted",
					...logout,
					sid: "another-session",
					createdAt: new Date(Date.now() - 3_600_000),
				},
			])
			.run();
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error("queue unavailable"))
			.mockResolvedValue(undefined);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await flushLogoutOutbox(db, { send });
			expect(send).toHaveBeenCalledTimes(2);
			expect((await rows()).map((row) => row.id)).toEqual(["refused"]);
		} finally {
			warned.mockRestore();
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("does not let a full batch of rejected handoffs starve a younger logout", async () => {
		const db = createDb(real);
		const old = new Date(Date.now() - 7_200_000);
		await db
			.insert(schema.logoutOutbox)
			.values(
				Array.from({ length: 3 }, (_, index) => ({
					id: `refused-${index}`,
					...logout,
					sid: `refused-session-${index}`,
					createdAt: old,
					lastAttemptAt: new Date(Date.now() - 300_000),
				})),
			)
			.run();
		await db
			.insert(schema.logoutOutbox)
			.values([
				{
					id: "younger",
					...logout,
					sid: "younger-session",
					createdAt: new Date(Date.now() - 3_600_000),
				},
			])
			.run();
		const send = vi.fn(async (body: { sid: string }) => {
			if (body.sid.startsWith("refused-")) throw new Error("queue refused");
		});
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await flushLogoutOutbox(db, { send }, 3);
			expect(send).toHaveBeenCalledTimes(3);
			expect(send).toHaveBeenNthCalledWith(
				1,
				{ ...logout, sid: "younger-session" },
				{ delaySeconds: 0 },
			);
			expect((await rows()).map((row) => row.id)).toEqual(["refused-0", "refused-1", "refused-2"]);
		} finally {
			warned.mockRestore();
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("prunes retained session identifiers after 24 hours", async () => {
		const db = createDb(real);
		await db
			.insert(schema.logoutOutbox)
			.values([
				{ id: "expired", ...logout, createdAt: new Date(Date.now() - 25 * 3_600_000) },
				{ id: "live", ...logout, createdAt: new Date(Date.now() - 23 * 3_600_000) },
			])
			.run();
		try {
			await pruneExpired(db);
			expect((await rows()).map((row) => row.id)).toEqual(["live"]);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});
});

describe("pruning and retrying the outbox", () => {
	const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

	it("prunes expired outbox rows even when an earlier table's prune fails", async () => {
		const { database, state } = faulty(real);
		state.only = /^delete from "session"/i;
		state.failures = 1;
		const db = createDb(real);
		await db
			.insert(schema.logoutOutbox)
			.values({ id: "expired", ...logout, createdAt: hoursAgo(25) })
			.run();
		try {
			await expect(pruneExpired(createDb(database))).rejects.toThrow();
			expect(await rows()).toHaveLength(0);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("prunes the other tables when the outbox's own prune fails", async () => {
		const { database, state } = faulty(real);
		state.only = /^delete from "logout_outbox"/i;
		state.failures = 1;
		const db = createDb(real);
		await db
			.insert(schema.verification)
			.values({
				id: "expired-code",
				identifier: "someone@example.com",
				value: "code",
				expiresAt: hoursAgo(1),
				createdAt: hoursAgo(2),
				updatedAt: hoursAgo(2),
			})
			.run();
		await expect(pruneExpired(createDb(database))).rejects.toThrow();
		expect(
			await db.select().from(schema.verification).where(eq(schema.verification.id, "expired-code")),
		).toHaveLength(0);
	});

	it("leaves a row past its retention to the prune instead of sending it again", async () => {
		const db = createDb(real);
		const send = vi.fn().mockResolvedValue(undefined);
		await db
			.insert(schema.logoutOutbox)
			.values({ id: "too-old", ...logout, createdAt: hoursAgo(25) })
			.run();
		try {
			await flushLogoutOutbox(db, { send });
			expect(send).not.toHaveBeenCalled();
			expect((await rows()).map((row) => row.id)).toEqual(["too-old"]);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("still retries owed logouts on the daily cron when pruning fails, then reports the failure", async () => {
		const { database, state } = faulty(real);
		state.only = /^delete from "session"/i;
		state.failures = 1;
		const db = createDb(real);
		const send = vi.fn().mockResolvedValue(undefined);
		await db
			.insert(schema.logoutOutbox)
			.values({ id: "owed", ...logout, createdAt: hoursAgo(1) })
			.run();
		try {
			await expect(runCron(createDb(database), "17 3 * * *", { send })).rejects.toThrow();
			expect(send).toHaveBeenCalledTimes(1);
			expect(await rows()).toHaveLength(0);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("prunes no other table on the outbox's own cron", async () => {
		const { database, state } = faulty(real);
		const send = vi.fn().mockResolvedValue(undefined);
		await runCron(createDb(database), OUTBOX_CRON, { send });
		expect(state.sent.some((query) => /^delete from "session"/i.test(query))).toBe(false);
	});

	it("removes a row past its retention on the outbox's own cron, without sending it", async () => {
		const db = createDb(real);
		const send = vi.fn().mockResolvedValue(undefined);
		await db
			.insert(schema.logoutOutbox)
			.values([
				{ id: "expired", ...logout, createdAt: hoursAgo(25) },
				{ id: "owed", ...logout, sid: "recent-session", createdAt: hoursAgo(1) },
			])
			.run();
		try {
			await runCron(db, OUTBOX_CRON, { send });
			expect(send).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledWith(
				{ clientId: logout.clientId, sub: logout.sub, sid: "recent-session" },
				{ delaySeconds: 0 },
			);
			expect(await rows()).toHaveLength(0);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});

	it("still retries on the outbox's own cron when its prune fails, then reports the failure", async () => {
		const { database, state } = faulty(real);
		state.only = /^delete from "logout_outbox" where "logout_outbox"."id" in \(select/i;
		state.failures = 1;
		const db = createDb(real);
		const send = vi.fn().mockResolvedValue(undefined);
		await db
			.insert(schema.logoutOutbox)
			.values({ id: "owed", ...logout, createdAt: hoursAgo(1) })
			.run();
		try {
			await expect(runCron(createDb(database), OUTBOX_CRON, { send })).rejects.toThrow();
			expect(send).toHaveBeenCalledTimes(1);
			expect(await rows()).toHaveLength(0);
		} finally {
			await db.delete(schema.logoutOutbox).run();
		}
	});
});
