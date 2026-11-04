import { type Column, inArray, lt } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneOlder(
	db: Database,
	table:
		| typeof schema.session
		| typeof schema.verification
		| typeof schema.oauthRefreshToken
		| typeof schema.oauthAccessToken
		| typeof schema.auditEvent,
	column: Column,
	before: Date,
) {
	for (;;) {
		const expired = db.select({ id: table.id }).from(table).where(lt(column, before)).limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * How long the audit log keeps an event. Long enough to look into something noticed late, and short
 * enough for what is personal data. Stated in "Audit log" in docs/architecture.md.
 */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * Deletes sessions, verifications and tokens past their time. Better Auth removes one only when
 * something looks it up, so those nobody comes back for would otherwise stay forever: an abandoned
 * sign-up's code, a GitHub sign-in that was never finished, a device that was never used again, and
 * a row for every token an app was ever given. Audit events go when they reach their age.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	await pruneOlder(db, schema.session, schema.session.expiresAt, now);
	await pruneOlder(db, schema.verification, schema.verification.expiresAt, now);
	// Refresh tokens first, because deleting one takes the access tokens made from it along.
	await pruneOlder(db, schema.oauthRefreshToken, schema.oauthRefreshToken.expiresAt, now);
	await pruneOlder(db, schema.oauthAccessToken, schema.oauthAccessToken.expiresAt, now);
	await pruneOlder(
		db,
		schema.auditEvent,
		schema.auditEvent.at,
		new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000),
	);
}
