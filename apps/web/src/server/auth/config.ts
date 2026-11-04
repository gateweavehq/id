import type { BetterAuthRateLimitOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { passwordResetEmail } from "../email/templates";
import { CLOSED_PATHS, firstPassword, signUpCodes, signUpHooks } from "./sign-up";

export interface AuthConfig {
	db: Database;
	secret: string;
	baseURL?: string | undefined;
	github?: { clientId: string; clientSecret: string } | undefined;
	/**
	 * Sends email. Without it there are no sign-up codes and no password reset, so the only way to
	 * an account is GitHub.
	 */
	mailer?: Mailer | undefined;
	/** Keeps work such as sending email going after the response, like `ctx.waitUntil`. */
	runInBackground?: ((work: Promise<unknown>) => void) | undefined;
	/** Where rate limits are counted. This isolate's memory without it. */
	rateLimitStorage?: BetterAuthRateLimitOptions["customStorage"];
	/** Whether one address may be sent another sign-up code. Unlimited without it. */
	allowSignUpCode?: ((email: string) => Promise<boolean>) | undefined;
}

/**
 * Builds the Better Auth instance. Kept free of `cloudflare:workers` imports so the Better Auth
 * CLI can load it to generate the database schema.
 *
 * The OIDC provider, passkeys and workspaces are not here yet: each arrives with the migration
 * that creates its tables.
 */
export function createAuth(config: AuthConfig) {
	const { mailer } = config;

	return betterAuth({
		secret: config.secret,
		baseURL: config.baseURL,
		database: drizzleAdapter(config.db, { provider: "sqlite", schema }),
		telemetry: { enabled: false },
		disabledPaths: CLOSED_PATHS,
		// Better Auth only turns its limiter on by itself when NODE_ENV is "production", which a
		// Worker never sets. Its built-in rules allow 3 sign-ins per 10 seconds per client. It
		// stays on in local dev too, so what works there works deployed.
		rateLimit: {
			enabled: true,
			...DEFAULT_AUTH_LIMIT,
			...(config.rateLimitStorage && { customStorage: config.rateLimitStorage }),
		},
		advanced: {
			ipAddress: {
				// Cloudflare sets this to the address it saw. Clients can add to X-Forwarded-For,
				// and Better Auth puts every request whose address it cannot trust in one bucket.
				ipAddressHeaders: ["cf-connecting-ip"],
			},
			// Email goes out after the response. For password reset and sign-up codes this also keeps
			// the response time the same whether or not the account exists.
			...(config.runInBackground && {
				backgroundTasks: { handler: config.runInBackground },
			}),
		},
		emailAndPassword: {
			enabled: true,
			// Accounts come from a sign-up code or GitHub. See "Sign-up" in docs/architecture.md.
			disableSignUp: true,
			requireEmailVerification: true,
			...(mailer && {
				sendResetPassword: async ({ user, url }) => {
					await mailer.send({ to: user.email, ...passwordResetEmail({ url }) });
				},
				// A reset is how someone takes an account back, so it ends every other session.
				revokeSessionsOnPasswordReset: true,
			}),
		},
		socialProviders: config.github ? { github: config.github } : {},
		databaseHooks: {
			user: {
				create: {
					// Apps and Cloudflare Access trust the `email` claim, and rules such as "anyone at
					// acme.com" rest on it. A sign-up code proves the address before this runs, so what
					// this refuses is a GitHub account whose address GitHub has not verified.
					before: async (user) => {
						if (!user.emailVerified) return false;
					},
				},
			},
		},
		hooks: signUpHooks(config.allowSignUpCode),
		plugins: [
			...(mailer ? [signUpCodes(mailer)] : []),
			firstPassword(),
			// Must stay last: forwards Set-Cookie headers from server-side auth calls.
			tanstackStartCookies(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

/** What a client may send to an auth path that has no rule of its own: Better Auth's default. */
export const DEFAULT_AUTH_LIMIT = { window: 10, max: 100 };
