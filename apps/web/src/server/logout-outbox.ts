import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { type Database, schema } from "./db";
import { LOGOUT_OUTBOX_RETENTION_HOURS, pruneExpired, pruneLogoutOutbox } from "./db/prune";

export interface OwedLogout {
	clientId: string;
	sub: string;
	sid: string;
}

/** The Queue binding method used here, kept narrow so failure paths can be tested. */
export interface LogoutQueue {
	send(body: OwedLogout, options: { delaySeconds: number }): Promise<unknown>;
}

const BATCH = 100;
const MIN_RETRY_AGE_MS = 60_000;

/**
 * Store before sending: a rejected Queue send leaves a row for the next cron. If D1 is unavailable,
 * still try the Queue. A successful send with a failed delete may duplicate the logout later; the
 * receiving app treats a second logout for the same session as success.
 */
export async function queueOrStoreLogout(
	db: Database,
	queue: LogoutQueue,
	logout: OwedLogout,
	delaySeconds: number,
): Promise<void> {
	const id = crypto.randomUUID();
	let stored = false;
	try {
		await db
			.insert(schema.logoutOutbox)
			.values({ id, ...logout, createdAt: new Date() })
			.run();
		stored = true;
	} catch (error) {
		console.warn(
			`could not store logout for client ${logout.clientId} before queue handoff`,
			error,
		);
	}

	try {
		await queue.send(logout, { delaySeconds });
	} catch (error) {
		if (!stored) throw error;
		console.warn(`queue handoff for client ${logout.clientId} failed; outbox will retry`, error);
		return;
	}

	if (stored) {
		try {
			await db.delete(schema.logoutOutbox).where(eq(schema.logoutOutbox.id, id)).run();
		} catch (error) {
			console.warn(`queued logout for client ${logout.clientId} remains in outbox`, error);
		}
	}
}

/**
 * Retry rows after the request's handoff has had time to finish. A row past its retention is left
 * for the daily prune: sending it again would give the Queue a fresh retry window and keep the
 * person's identifiers in flight past the 24 hours the outbox promises.
 */
export async function flushLogoutOutbox(
	db: Database,
	queue: LogoutQueue,
	batchSize = BATCH,
): Promise<void> {
	const now = Date.now();
	const rows = await db
		.select()
		.from(schema.logoutOutbox)
		.where(
			and(
				lt(schema.logoutOutbox.createdAt, new Date(now - MIN_RETRY_AGE_MS)),
				gt(
					schema.logoutOutbox.createdAt,
					new Date(now - LOGOUT_OUTBOX_RETENTION_HOURS * 3_600_000),
				),
			),
		)
		// Untried rows go first. A persistently failing row must not occupy this whole batch.
		.orderBy(
			asc(sql`coalesce(${schema.logoutOutbox.lastAttemptAt}, 0)`),
			schema.logoutOutbox.createdAt,
		)
		.limit(batchSize);
	for (const row of rows) {
		try {
			await queue.send({ clientId: row.clientId, sub: row.sub, sid: row.sid }, { delaySeconds: 0 });
			await db.delete(schema.logoutOutbox).where(eq(schema.logoutOutbox.id, row.id)).run();
		} catch (error) {
			console.warn(`outbox handoff for client ${row.clientId} failed; will retry`, error);
			try {
				await db
					.update(schema.logoutOutbox)
					.set({ lastAttemptAt: new Date() })
					.where(eq(schema.logoutOutbox.id, row.id))
					.run();
			} catch (updateError) {
				console.warn(`could not postpone outbox row ${row.id}`, updateError);
			}
		}
	}
}

/** The cron that only retries logout handoffs; any other firing is the daily one. */
export const OUTBOX_CRON = "*/5 * * * *";

/**
 * One cron firing. The daily one prunes every table; the five-minute one prunes only the outbox, so
 * its rows are gone within 24 hours of being written. Every firing retries owed logouts. A prune that
 * fails must not hold back the retries, so its error is thrown only after them.
 */
export async function runCron(
	db: Database,
	cron: string,
	queue: LogoutQueue | undefined,
): Promise<void> {
	let pruneFailure: unknown;
	let pruneFailed = false;
	try {
		await (cron === OUTBOX_CRON ? pruneLogoutOutbox(db) : pruneExpired(db));
	} catch (error) {
		pruneFailure = error;
		pruneFailed = true;
	}
	if (queue) await flushLogoutOutbox(db, queue);
	if (pruneFailed) throw pruneFailure;
}
