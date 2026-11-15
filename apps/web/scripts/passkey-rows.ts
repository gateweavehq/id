import { sqlValue } from "../src/server/auth/app-row.ts";

/** One row for the person, with how many passkeys they have. None for an address nobody has. */
export function passkeyStateQuery(email: string): string {
	return `SELECT (SELECT COUNT(*) FROM "passkey" WHERE "passkey"."user_id" = "user"."id") AS "passkeys" FROM "user" WHERE "email" = ${sqlValue(email)};`;
}

/**
 * What `/account/remove-passkey` does, for someone who cannot reach it: it takes a sign-in with two
 * factors, and theirs was the passkey they lost. All of them go, since whoever runs this cannot tell
 * one from another and the person can add those they still hold again. Their sessions stay, as they
 * do when two-factor is turned off this way. The log's line comes first, while there is still
 * something that says they had one, and is one line however many there were.
 */
export function removePasskeysStatements(email: string, now = Date.now()): string[] {
	const address = sqlValue(email);
	const event = [crypto.randomUUID(), now, "passkey_removed"].map(sqlValue).join(", ");
	return [
		`INSERT INTO "audit_event" ("id", "at", "type", "user_id", "detail") SELECT ${event}, "id", 'operator' FROM "user" WHERE "email" = ${address} AND EXISTS (SELECT 1 FROM "passkey" WHERE "passkey"."user_id" = "user"."id");`,
		`DELETE FROM "passkey" WHERE "user_id" IN (SELECT "id" FROM "user" WHERE "email" = ${address});`,
	];
}
