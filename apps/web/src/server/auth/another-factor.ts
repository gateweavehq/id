import type { GenericEndpointContext } from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import { isTwoFactor } from "../../lib/sign-in-method";
import type { Database } from "../db";
import { schema } from "../db";

// "Adding a second factor" and "Taking a second factor away" in docs/architecture.md. A workspace
// that requires two-factor sign-in goes by how a session was made, so a new passkey or authenticator
// is a way past it for whoever can add one. Someone who holds one of a person's factors must not be
// able to make themselves the other, and must not be able to take the other away either, since an
// account with none left takes its next one on trust.

/** What someone already has that makes a sign-in count as two factors. */
export interface SecondFactors {
	/** Two-factor sign-in is on: a password is followed by a code. */
	authenticator: boolean;
	passkey: boolean;
}

export async function secondFactorsOf(db: Database, userId: string): Promise<SecondFactors> {
	const [person, passkey] = await Promise.all([
		db
			.select({ twoFactorEnabled: schema.user.twoFactorEnabled })
			.from(schema.user)
			.where(eq(schema.user.id, userId))
			.get(),
		db
			.select({ id: schema.passkey.id })
			.from(schema.passkey)
			.where(eq(schema.passkey.userId, userId))
			.limit(1)
			.get(),
	]);
	return { authenticator: person?.twoFactorEnabled === true, passkey: passkey !== undefined };
}

/**
 * What the person asking already has, if the session they ask with showed one factor. Null when it
 * showed two, which may add and remove whatever it likes, and when nobody is signed in, which the
 * endpoint refuses by itself.
 *
 * Someone with no second factor yet gets one from a session with one factor: there is nothing else
 * they could show, and a workspace's rule could otherwise never be met. That is trust on first use,
 * and it means the rule cannot say that whoever enrolled was the person.
 *
 * What they do have, a session with one factor neither adds to nor takes away.
 */
export async function factorsBehindOneFactor(
	db: Database,
	ctx: GenericEndpointContext,
): Promise<SecondFactors | null> {
	const session = await getSessionFromCtx(ctx);
	if (!session) return null;
	if (isTwoFactor((session.session as { signInMethod?: unknown }).signInMethod)) return null;
	return secondFactorsOf(db, session.user.id);
}
