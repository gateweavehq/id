import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	freshSessionMiddleware,
	setPassword,
} from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { z } from "zod";
import type { Mailer } from "../email/mailer";
import { accountExistsEmail, signUpCodeEmail } from "../email/templates";

// Sign-up proves the address before an account exists, and the password comes after that. See
// "Sign-up" in docs/architecture.md for the attack this closes.

const SEND_CODE = "/email-otp/send-verification-otp";
const USE_CODE = "/sign-in/email-otp";
const UPDATE_USER = "/update-user";
const FIRST_PASSWORD = "/account/first-password";

const CODE_LIFETIME_SECONDS = 10 * 60;

/**
 * What this server does not offer. Password-first sign-up and link verification are the attack
 * itself, and the rest of the email-otp plugin would give anyone with a mailbox a way around the
 * password and two-factor.
 */
export const CLOSED_PATHS = [
	"/sign-up/email",
	"/send-verification-email",
	"/verify-email",
	"/email-otp/check-verification-otp",
	"/email-otp/verify-email",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/email-otp/reset-password",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
];

/** The same words for a wrong code, an old code and an address that cannot use one. */
const WRONG_CODE = {
	code: "INVALID_OTP",
	message: "That code is wrong or has expired. Check it, or ask for a new one.",
};
const REFUSALS_OF_A_CODE = new Set<string>(["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]);

const name = z.string().trim().min(1).max(100);
const address = z.email();

function assertValidName(value: unknown) {
	if (!name.safeParse(value).success) {
		throw APIError.from("BAD_REQUEST", {
			code: "INVALID_NAME",
			message: "Enter a name of at most 100 characters.",
		});
	}
}

/**
 * Sends the code a sign-up needs. An address that already has an account is told so instead, and
 * gets no code, so that from outside the two look the same.
 */
export function signUpCodes(mailer: Mailer) {
	return {
		...emailOTP({
			expiresIn: CODE_LIFETIME_SECONDS,
			allowedAttempts: 3,
			storeOTP: "hashed",
			async sendVerificationOTP({ email, otp, type }, ctx) {
				// The hook below turns away every other type, so this only guards against a gap there.
				if (type !== "sign-in" || !ctx) return;
				const existing = await ctx.context.internalAdapter.findUserByEmail(email);
				if (existing) {
					const { origin } = new URL(ctx.context.baseURL);
					const query = new URLSearchParams({ email }).toString();
					await mailer.send({
						to: email,
						...accountExistsEmail({
							signInUrl: `${origin}/login?${query}`,
							resetUrl: `${origin}/forgot-password?${query}`,
						}),
					});
					return;
				}
				await mailer.send({
					to: email,
					...signUpCodeEmail({ code: otp, minutes: CODE_LIFETIME_SECONDS / 60, email }),
				});
			},
		}),
		// "Too many attempts" and "expired" can only come from an address with no account, so they
		// would tell a stranger which addresses have one. Here because a hook cannot change a status.
		async onResponse(response: Response) {
			if (response.status !== 400 && response.status !== 403) return;
			const body = await response
				.clone()
				.json<{ code?: string }>()
				.catch(() => null);
			if (!body?.code || !REFUSALS_OF_A_CODE.has(body.code)) return;
			return {
				response: Response.json(WRONG_CODE, { status: 400, headers: response.headers }),
			};
		},
	};
}

/**
 * Better Auth's `email-otp` plugin is a way to sign in as well as to sign up. ID only wants the
 * second, so these hooks hold it to that.
 *
 * `allowCode` caps the codes one address can be sent. It runs before a code is stored: each new
 * code resets the attempts, so the guesses against one address would otherwise be limited only by
 * how many clients ask.
 */
export function signUpHooks(allowCode: ((email: string) => Promise<boolean>) | undefined) {
	return {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path === SEND_CODE) {
				if (ctx.body?.type !== "sign-in") {
					throw APIError.from("BAD_REQUEST", {
						code: "INVALID_CODE_TYPE",
						message: "Codes are only for signing up.",
					});
				}
				const email = address.safeParse(ctx.body?.email);
				// The plugin answers an address that is not one. Over the cap, nothing is stored or
				// sent and the answer stays the same, as for an email the mailer drops.
				if (email.success && allowCode && !(await allowCode(email.data.toLowerCase()))) {
					return ctx.json({ success: true });
				}
			}

			if (ctx.path === USE_CODE) {
				assertValidName(ctx.body?.name);
				// Fails closed whatever the code is. Someone with the mailbox must not get in past the
				// password, and a code sent before an account appeared must not work after it did.
				const email = typeof ctx.body?.email === "string" ? ctx.body.email.toLowerCase() : "";
				if (await ctx.context.internalAdapter.findUserByEmail(email)) {
					throw APIError.from("BAD_REQUEST", WRONG_CODE);
				}
			}

			if (ctx.path === UPDATE_USER && ctx.body?.name !== undefined) {
				assertValidName(ctx.body.name);
			}
		}),
	};
}

/**
 * Gives an account its first password. Better Auth keeps `setPassword` server-only, so the pages
 * reach it through this, which adds what a public path needs: the origin check and rate limit
 * every path gets, and a recent session, because setting a password outlasts a stolen cookie.
 */
export function firstPassword() {
	return {
		id: "first-password",
		endpoints: {
			setFirstPassword: createAuthEndpoint(
				FIRST_PASSWORD,
				{
					method: "POST",
					body: z.object({ newPassword: z.string() }),
					use: [freshSessionMiddleware],
				},
				(ctx) => setPassword(ctx),
			),
		},
		rateLimit: [
			{
				pathMatcher: (path: string) => path === FIRST_PASSWORD,
				window: 60,
				max: 5,
			},
		],
	} satisfies BetterAuthPlugin;
}
