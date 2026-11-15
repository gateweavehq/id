import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import {
	TWO_FACTORS_TO_ADD_AN_AUTHENTICATOR,
	TWO_FACTORS_TO_CHANGE_TWO_FACTOR,
} from "../../lib/sign-in-method";
import type { Database } from "../db";
import { factorsBehindOneFactor } from "./another-factor";
import { ownerOfChallenge, type RecordEvent, whereFrom } from "./audit";

const ENABLE = "/two-factor/enable";
const DISABLE = "/two-factor/disable";
const REPLACE_RECOVERY_CODES = "/two-factor/generate-backup-codes";
const VERIFY_TOTP = "/two-factor/verify-totp";
const VERIFY_RECOVERY_CODE = "/two-factor/verify-backup-code";

/**
 * `get-totp-uri` would show the secret again to anyone with the password and a session, which is a
 * second authenticator the person never hears of. The other two would send codes by email, and a
 * mailbox is also what resets a password, so one person's mailbox would be both factors.
 */
export const TWO_FACTOR_CLOSED_PATHS = [
	"/two-factor/get-totp-uri",
	"/two-factor/send-otp",
	"/two-factor/verify-otp",
];

const TOTP_CODE = /^\d{6}$/;

/** Nothing that looks like something else, and one case: these may be read off paper, on a bad day. */
const RECOVERY_CODE_CHARACTERS = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_CODE_LENGTH = 10;
const RECOVERY_CODES = 10;

function recoveryCode(): string {
	// Bytes past the last whole multiple are thrown away, or some characters would come up more often.
	const usable = 256 - (256 % RECOVERY_CODE_CHARACTERS.length);
	let code = "";
	while (code.length < RECOVERY_CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_LENGTH))) {
			if (byte < usable && code.length < RECOVERY_CODE_LENGTH) {
				code += RECOVERY_CODE_CHARACTERS.charAt(byte % RECOVERY_CODE_CHARACTERS.length);
			}
		}
	}
	return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export interface TwoFactorSettings {
	db: Database;
	record: RecordEvent;
	/** Whether this is the first time this person's code has been offered. See below. */
	firstUseOfCode: ((key: string) => Promise<boolean>) | undefined;
}

/**
 * Better Auth's two-factor plugin, held to "every sign-in with a password asks for a code". See
 * "Two-factor sign-in" in docs/architecture.md.
 *
 * These must come before the OIDC provider's plugin. Hooks run in plugin order, and the provider's
 * carries on to the app when it sees a session being set. The plugin's is what takes that session
 * away while a code is still owed, so the other way round a password alone would make a code for the
 * app.
 */
export function twoFactorPlugins(settings: TwoFactorSettings) {
	return [
		twoFactor({
			issuer: "Gateweave ID",
			backupCodeOptions: {
				customBackupCodesGenerate: () => Array.from({ length: RECOVERY_CODES }, recoveryCode),
			},
		}),
		twoFactorRules(settings),
	];
}

function twoFactorRules({ db, record, firstUseOfCode }: TwoFactorSettings) {
	return {
		id: "two-factor-rules",
		hooks: {
			before: [
				{
					// Asking for an authenticator, and confirming one while signed in, which is what turns
					// two-factor on and makes the session one that showed a code.
					matcher: ({ path }) => path === ENABLE || path === VERIFY_TOTP,
					handler: createAuthMiddleware(async (ctx) => {
						// As for a passkey: someone who has one, and whose password another person holds,
						// must not get an authenticator from that password. See `another-factor.ts`.
						const has = await factorsBehindOneFactor(db, ctx);
						if (!has) return;
						// With two-factor on, a code offered from a session changes nothing, and is not an
						// authenticator being added.
						const adding = ctx.path === ENABLE || !has.authenticator;
						if (adding && (has.authenticator || has.passkey)) {
							throw APIError.from("FORBIDDEN", TWO_FACTORS_TO_ADD_AN_AUTHENTICATOR);
						}
					}),
				},
				{
					// Turning it off, and new recovery codes, each of which is a code to sign in with.
					matcher: ({ path }) => path === DISABLE || path === REPLACE_RECOVERY_CODES,
					handler: createAuthMiddleware(async (ctx) => {
						// Both take the password, which is the one factor that whoever holds it has. With
						// two-factor off the account has no second factor and takes the next on trust, and
						// new recovery codes are a second factor handed over. So a session that showed one
						// factor does neither: another device signed in before it was turned on, GitHub's,
						// or one that does not say how it was made. A recovery code after the password is
						// two, which is how someone who lost their authenticator turns it off themselves.
						const has = await factorsBehindOneFactor(db, ctx);
						if (has?.authenticator) {
							throw APIError.from("FORBIDDEN", TWO_FACTORS_TO_CHANGE_TWO_FACTOR);
						}
					}),
				},
				{
					matcher: ({ path }) => path === VERIFY_TOTP || path === VERIFY_RECOVERY_CODE,
					handler: createAuthMiddleware(async (ctx) => {
						// A remembered device would be a sign-in with a password alone for 30 days, and a
						// recovery code spent without a session is nothing anyone needs.
						if (ctx.body?.trustDevice || ctx.body?.disableSession) {
							throw APIError.from("BAD_REQUEST", {
								code: "NOT_OFFERED",
								message: "Every sign-in with a password asks for a code.",
							});
						}
						if (ctx.path !== VERIFY_TOTP || !firstUseOfCode) return;
						const code = ctx.body?.code;
						if (typeof code !== "string" || !TOTP_CODE.test(code)) return;
						const owner = await ownerOfChallenge(ctx);
						if (!owner) return;
						// The plugin takes a code as long as it is valid, which is about a minute and a half,
						// so someone who saw one could use it again. It is claimed before it is checked,
						// because checking first would let two requests with one code both through. A wrong
						// code claimed this way harms nothing, and gets the same answer as any wrong code.
						if (await firstUseOfCode(`${owner.id}:${code}`)) return;
						record("sign_in_failed", {
							userId: owner.id,
							detail: "totp",
							...whereFrom(ctx.headers),
						});
						throw APIError.from("UNAUTHORIZED", {
							code: "INVALID_CODE",
							message: "Invalid code",
						});
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
