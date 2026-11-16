import { count, eq } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";

/**
 * What someone has to sign in with, for their account page to say. It answers about the one session
 * it is handed, read once by whoever calls it, and fails as a whole without one: a page that got
 * half an answer would say "Passkeys: None" of someone who has two.
 *
 * GitHub counts only where this server offers it, since a link made while it did signs nobody in
 * once it does not.
 */
export async function waysToSignIn(
	db: Database,
	session: { user: { id: string } } | null,
	githubSignIn: boolean,
) {
	if (!session) throw new Error("There is no session to say how its person signs in");
	const userId = session.user.id;
	const [accounts, passkeys] = await Promise.all([
		db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, userId))
			.all(),
		db
			.select({ held: count() })
			.from(schema.passkey)
			.where(eq(schema.passkey.userId, userId))
			.get(),
	]);
	return {
		password: accounts.some(({ providerId }) => providerId === "credential"),
		github: githubSignIn && accounts.some(({ providerId }) => providerId === "github"),
		passkeys: passkeys?.held ?? 0,
	};
}
