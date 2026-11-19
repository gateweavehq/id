import { asc, eq, lt, sql } from "drizzle-orm";
import { type Database, schema } from "./db";

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

/** Retry rows after the request's handoff has had time to finish. */
export async function flushLogoutOutbox(
	db: Database,
	queue: LogoutQueue,
	batchSize = BATCH,
): Promise<void> {
	const rows = await db
		.select()
		.from(schema.logoutOutbox)
		.where(lt(schema.logoutOutbox.createdAt, new Date(Date.now() - MIN_RETRY_AGE_MS)))
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
