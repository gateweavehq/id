import type { BetterAuthRateLimitOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { captcha } from "better-auth/plugins/captcha";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { TURNSTILE_ACTION } from "../../lib/turnstile-action";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { passwordResetEmail } from "../email/templates";
import { allowedAppsPlugin } from "./allowed-apps";
import { auditDatabaseHooks, auditLog, auditRecorder, whereFrom } from "./audit";
import { breachedPasswords } from "./breached-passwords";
import { deleteAccountPlugin } from "./delete-account";
import { deploymentPlugin, mayMakeAccount, SIGN_UP_CLOSED } from "./deployment";
import { OIDC_CLOSED_PATHS, type OidcConfig, oidcPlugins } from "./oidc";
import { PASSKEY_CLOSED_PATHS, passkeyPlugins } from "./passkeys";
import { passwordChange } from "./password-change";
import { passwordRemoval } from "./password-removal";
import { passwordTries, tellOfSpentTries } from "./password-tries";
import { CLOSED_PATHS, firstPassword, signUpCodes, signUpHooks } from "./sign-up";
import { TWO_FACTOR_CLOSED_PATHS, twoFactorPlugins } from "./two-factor";
import { workspaceAppsPlugin } from "./workspace-apps";
import { workspaceGroupsPlugin } from "./workspace-groups";
import { workspacePlugins } from "./workspaces";

export interface AuthConfig {
	db: Database;
	secret: string;
	baseURL?: string | undefined;
	/**
	 * Marks cookies `Secure` whatever the base URL says. Without a pinned `baseURL`, Better Auth
	 * decides from NODE_ENV, which a Worker never has, and leaves the attribute off.
	 */
	secureCookies?: boolean | undefined;
	github?: { clientId: string; clientSecret: string } | undefined;
	/**
	 * Sends email. Without it there are no sign-up codes, an account comes from GitHub or a link from
	 * the server's owner, and only that owner can make a link for choosing a new password.
	 */
	mailer?: Mailer | undefined;
	/** Keeps work such as sending email going after the response, like `ctx.waitUntil`. */
	runInBackground?: ((work: Promise<unknown>) => void) | undefined;
	/** Where rate limits are counted. This isolate's memory without it. */
	rateLimitStorage?: BetterAuthRateLimitOptions["customStorage"];
	/** Whether one address may be sent another sign-up code. Unlimited without it. */
	allowSignUpCode?: ((email: string) => Promise<boolean>) | undefined;
	/** Whether an authenticator's code is being offered for the first time. Unchecked without it. */
	firstUseOfCode?: ((key: string) => Promise<boolean>) | undefined;
	/** Whether this person may send another invitation, to this address. Unlimited without it. */
	allowInvitation?: ((inviterId: string, email: string) => Promise<boolean>) | undefined;
	/** Whether someone signed in as this person may offer another password. Unlimited without it. */
	allowPasswordTry?: ((userId: string) => Promise<boolean>) | undefined;
	/** Whether this person may be emailed about those tries running out. Never without it. */
	allowSpentTriesEmail?: ((userId: string) => Promise<boolean>) | undefined;
	/** Puts Cloudflare Turnstile in front of the paths bots go for. Off without it. */
	turnstileSecretKey?: string | undefined;
	/** Refuses passwords known from breaches, by asking a service outside this deployment. */
	checkBreachedPasswords?: boolean | undefined;
	/** Makes this deployment an OIDC provider. Apps cannot sign anyone in without it. */
	oidc?: OidcConfig | undefined;
}

/**
 * Sending email, because each request costs money and reputation, and password sign-in, because
 * it is what credential stuffing aims at. GitHub and a passkey have nothing to guess.
 */
const TURNSTILE_PATHS = [
	"/email-otp/send-verification-otp",
	"/sign-in/email",
	"/request-password-reset",
	// Whoever gets there first owns the server, which is worth a scanner's while.
	"/deployment/claim",
];

/**
 * ID asks a provider who someone is when they sign in, and never calls it for them afterwards. A
 * token it does not keep cannot leak.
 */
const NO_TOKENS = {
	accessToken: null,
	refreshToken: null,
	idToken: null,
	accessTokenExpiresAt: null,
	refreshTokenExpiresAt: null,
};

/**
 * Builds the Better Auth instance. Kept free of `cloudflare:workers` imports so the Better Auth
 * CLI can load it to generate the database schema.
 */
export function createAuth(config: AuthConfig) {
	const { mailer } = config;
	const record = auditRecorder(config.db, config.runInBackground);
	const audit = auditDatabaseHooks(config.db, record);

	return betterAuth({
		secret: config.secret,
		baseURL: config.baseURL,
		database: drizzleAdapter(config.db, { provider: "sqlite", schema }),
		telemetry: { enabled: false },
		disabledPaths: [
			...CLOSED_PATHS,
			...OIDC_CLOSED_PATHS,
			...PASSKEY_CLOSED_PATHS,
			...TWO_FACTOR_CLOSED_PATHS,
			// Says whether a password is right to anyone with the cookie, many times a second, and
			// leaves no audit row. Nothing here uses it.
			"/verify-password",
			// An account keeps none of a provider's tokens, so these have nothing to give.
			"/get-access-token",
			"/refresh-token",
			"/account-info",
		],
		// Better Auth only turns its limiter on by itself when NODE_ENV is "production", which a
		// Worker never sets. Its built-in rules allow 3 sign-ins per 10 seconds per client. It
		// stays on in local dev too, so what works there works deployed.
		rateLimit: {
			enabled: true,
			...DEFAULT_AUTH_LIMIT,
			...(config.rateLimitStorage && { customStorage: config.rateLimitStorage }),
		},
		advanced: {
			// Each query is a trip to the database's one primary from wherever the Worker runs, about
			// 240 ms from Tokyo. This reads a session and its person in one.
			database: { joins: true },
			ipAddress: {
				// Cloudflare sets this to the address it saw. Clients can add to X-Forwarded-For,
				// and Better Auth puts every request whose address it cannot trust in one bucket.
				ipAddressHeaders: ["cf-connecting-ip"],
			},
			// Only the attribute: `useSecureCookies` would also rename the cookies to `__Secure-...`,
			// which signs everyone out.
			...(config.secureCookies && { defaultCookieAttributes: { secure: true } }),
			// Email goes out after the response, so sending it is no part of how long an answer takes.
			// `even-answer.ts` holds the rest of that time to a minimum.
			...(config.runInBackground && {
				backgroundTasks: { handler: config.runInBackground },
			}),
		},
		emailAndPassword: {
			enabled: true,
			// Accounts come from a sign-up code or GitHub. See "Sign-up" in docs/architecture.md.
			disableSignUp: true,
			requireEmailVerification: true,
			// A reset is how someone takes an account back, so it ends every other session.
			revokeSessionsOnPasswordReset: true,
			onPasswordReset: async ({ user }, request) => {
				record("password_changed", {
					userId: user.id,
					// Without email nobody can ask for a reset, so this came from the server's owner.
					detail: mailer ? "reset" : "link",
					...whereFrom(request?.headers),
				});
			},
			...(mailer && {
				sendResetPassword: async ({ user, url }) => {
					await mailer.send({ to: user.email, ...passwordResetEmail({ url }) });
				},
			}),
		},
		socialProviders: config.github
			? {
					github: {
						...config.github,
						// Enough to read someone's verified addresses, which is all ID asks GitHub.
						disableDefaultScope: true,
						scope: ["user:email"],
					},
				}
			: {},
		// Better Auth's own error page knows nothing of this app. The sign-in page explains a refusal.
		onAPIError: { errorURL: "/login" },
		account: {
			// With no tokens kept, signing in again has nothing to refresh.
			updateAccountOnSignIn: false,
			// Better Auth links a provider to an account when both say the address is verified. Without
			// email, ours says so on the word of whoever held the link, so linking could hand someone
			// an account another person had already chosen the password of.
			accountLinking: { disableImplicitLinking: !mailer },
		},
		databaseHooks: {
			user: {
				create: {
					// Apps and Cloudflare Access trust the `email` claim, and rules such as "anyone at
					// acme.com" rest on it. A sign-up code proves the address before this runs, so what
					// this refuses is a GitHub account whose address GitHub has not verified.
					before: async (user) => {
						if (!user.emailVerified) {
							throw APIError.from("FORBIDDEN", {
								code: "EMAIL_NOT_VERIFIED",
								message: "This email address is not verified",
							});
						}
						if (!(await mayMakeAccount(config.db, user.email))) {
							throw APIError.from("FORBIDDEN", SIGN_UP_CLOSED);
						}
					},
					after: audit.user.afterCreate,
				},
				update: { after: audit.user.afterUpdate },
			},
			account: {
				create: {
					before: async (account) => ({ data: { ...account, ...NO_TOKENS } }),
					after: audit.account.afterCreate,
				},
				update: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
				delete: { after: audit.account.afterDelete },
			},
			session: { create: { after: audit.session.afterCreate } },
		},
		hooks: signUpHooks(config.db, config.allowSignUpCode),
		plugins: [
			...(config.turnstileSecretKey
				? [
						captcha({
							provider: "cloudflare-turnstile",
							secretKey: config.turnstileSecretKey,
							endpoints: TURNSTILE_PATHS,
							expectedAction: TURNSTILE_ACTION,
							allowedHostnames: config.baseURL ? [new URL(config.baseURL).hostname] : undefined,
						}),
					]
				: []),
			...(mailer ? [signUpCodes(mailer)] : []),
			// Before anything else looks at a password these paths were given, or asks anyone about it.
			passwordTries({
				record,
				allow: config.allowPasswordTry,
				tell: (person) => tellOfSpentTries(person, mailer, config.allowSpentTriesEmail),
			}),
			...(config.checkBreachedPasswords ? [breachedPasswords()] : []),
			firstPassword(),
			passwordChange(mailer),
			passwordRemoval(record),
			// A passkey is bound to a host for good, so it has to be set on purpose, as the issuer does.
			...(config.baseURL
				? passkeyPlugins(config.db, {
						baseURL: config.baseURL,
						githubSignIn: Boolean(config.github),
					})
				: []),
			// Before the provider, which must not see a session that a code is still owed for.
			...twoFactorPlugins({ record, firstUseOfCode: config.firstUseOfCode }),
			auditLog(config.db, record),
			deleteAccountPlugin({ db: config.db, mailer, record }),
			deploymentPlugin({
				db: config.db,
				mailer,
				gitHub: Boolean(config.github),
				record,
				allowInvitation: config.allowInvitation,
			}),
			...workspacePlugins({
				db: config.db,
				baseURL: config.baseURL,
				mailer,
				record,
				allowInvitation: config.allowInvitation,
				appsEnabled: Boolean(config.oidc),
			}),
			...(config.oidc
				? [
						...oidcPlugins(config.db, config.oidc, record),
						// With no provider, no app could sign anyone in.
						workspaceAppsPlugin({ db: config.db, issuer: config.oidc.issuer, record }),
						workspaceGroupsPlugin({ db: config.db, record }),
						allowedAppsPlugin({ db: config.db, record }),
					]
				: []),
			// Must stay last: forwards Set-Cookie headers from server-side auth calls.
			tanstackStartCookies(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

/** What a client may send to an auth path that has no rule of its own: Better Auth's default. */
export const DEFAULT_AUTH_LIMIT = { window: 10, max: 100 };
