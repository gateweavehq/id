import { sqlValue } from "./app-row.ts";

/** One row for the person, whether or not it is on. None for an address nobody has. */
export function twoFactorStateQuery(email: string): string {
	return `SELECT "two_factor_enabled" FROM "user" WHERE "email" = ${sqlValue(email)};`;
}

/**
 * What `/two-factor/disable` changes, for someone who cannot reach it. Their sessions stay: they lost a
 * device, and nobody said anyone else has it. The log's line comes first, while there is still
 * something that says it was on.
 */
export function removeTwoFactorStatements(email: string, now = Date.now()): string[] {
	const address = sqlValue(email);
	const event = [crypto.randomUUID(), now, "two_factor_disabled"].map(sqlValue).join(", ");
	return [
		`INSERT INTO "audit_event" ("id", "at", "type", "user_id", "detail") SELECT ${event}, "id", 'operator' FROM "user" WHERE "email" = ${address} AND "two_factor_enabled" = 1;`,
		`DELETE FROM "two_factor" WHERE "user_id" IN (SELECT "id" FROM "user" WHERE "email" = ${address});`,
		`UPDATE "user" SET "two_factor_enabled" = 0 WHERE "email" = ${address};`,
	];
}
