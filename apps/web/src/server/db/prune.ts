import { inArray, lt } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneTable(db: Database, table: typeof schema.session | typeof schema.verification) {
	const now = new Date();
	for (;;) {
		const expired = db
			.select({ id: table.id })
			.from(table)
			.where(lt(table.expiresAt, now))
			.limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * Deletes sessions and verifications past their time. Better Auth removes one only when something
 * looks it up, so those nobody comes back for would otherwise stay forever: an abandoned sign-up's
 * code, a GitHub sign-in that was never finished, a device that was never used again.
 */
export async function pruneExpired(db: Database): Promise<void> {
	await pruneTable(db, schema.session);
	await pruneTable(db, schema.verification);
}
