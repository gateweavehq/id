import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";

/** Everywhere someone chooses a password. */
const PATHS = [
	"/change-password",
	"/reset-password",
	"/account/first-password",
	"/deployment/invitations/accept",
	"/deployment/claim",
];

/** Long enough for a slow answer, and short enough that the form does not seem stuck. */
const TIMEOUT_MS = 3000;

function withinTimeout(password: string): Promise<boolean> {
	const timedOut = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Timed out")), TIMEOUT_MS);
	});
	return Promise.race([isPasswordCompromised(password), timedOut]);
}

/**
 * Refuses a password Have I Been Pwned has seen in a breach. Only the first five characters of its
 * SHA-1 leave ID, so the service never learns the password.
 *
 * When the service cannot answer, the password goes through. Better Auth's own plugin refuses it
 * instead, but a reset is how someone takes their account back, and another company's outage should
 * not stand in the way of that.
 */
export function breachedPasswords(): BetterAuthPlugin {
	return {
		id: "breached-passwords",
		hooks: {
			before: [
				{
					matcher: (ctx) => PATHS.includes(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const password: unknown = ctx.body?.newPassword;
						if (typeof password !== "string") return;
						let breached: boolean;
						try {
							breached = await withinTimeout(password);
						} catch (error) {
							ctx.context.logger.warn("Could not check a password for breaches", error);
							return;
						}
						if (breached) {
							throw APIError.from("BAD_REQUEST", {
								code: "PASSWORD_COMPROMISED",
								message:
									"This password has appeared in a data breach, so attackers are likely to try it. Choose another.",
							});
						}
					}),
				},
			],
		},
	};
}
