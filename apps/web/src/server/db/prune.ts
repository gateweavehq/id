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
		| typeof schema.invitation
		| typeof schema.deploymentInvitation
		| typeof schema.logoutOutbox
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
/** Match the Queue's roughly 20-hour retry horizon without retaining session identifiers indefinitely. */
export const LOGOUT_OUTBOX_RETENTION_HOURS = 24;

/**
 * Deletes logout outbox rows past their retention. The five-minute cron runs it as well as the daily
 * one: with the daily run alone, a row written just after it would stay for nearly two days.
 */
export function pruneLogoutOutbox(db: Database, now = new Date()): Promise<void> {
	return pruneOlder(
		db,
		schema.logoutOutbox,
		schema.logoutOutbox.createdAt,
		new Date(now.getTime() - LOGOUT_OUTBOX_RETENTION_HOURS * 3_600_000),
	);
}

/**
 * Deletes sessions, verifications and tokens past their time. Better Auth removes one only when
 * something looks it up, so those nobody comes back for would otherwise stay forever: an abandoned
 * sign-up's code, a GitHub sign-in that was never finished, a device that was never used again, and
 * a row for every token an app was ever given. An invitation goes too, and with it an address that
 * may never have had anything to do with this deployment. Audit events go when they reach their age.
 *
 * Each table is pruned on its own: one that fails, a large audit log say, must not keep the others,
 * least of all the logout outbox, whose rows hold a person's pairwise subject and session. The first
 * failure is thrown once every table has had its turn.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	const prunes: (() => Promise<void>)[] = [
		() => pruneLogoutOutbox(db, now),
		() => pruneOlder(db, schema.session, schema.session.expiresAt, now),
		() => pruneOlder(db, schema.verification, schema.verification.expiresAt, now),
		// Refresh tokens first, because deleting one takes the access tokens made from it along.
		() => pruneOlder(db, schema.oauthRefreshToken, schema.oauthRefreshToken.expiresAt, now),
		() => pruneOlder(db, schema.oauthAccessToken, schema.oauthAccessToken.expiresAt, now),
		() => pruneOlder(db, schema.invitation, schema.invitation.expiresAt, now),
		() => pruneOlder(db, schema.deploymentInvitation, schema.deploymentInvitation.expiresAt, now),
		() =>
			pruneOlder(
				db,
				schema.auditEvent,
				schema.auditEvent.at,
				new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000),
			),
	];
	const failures: unknown[] = [];
	// One after another: D1 runs one query at a time, so running them together would gain nothing.
	for (const prune of prunes) {
		try {
			await prune();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw failures[0];
}
