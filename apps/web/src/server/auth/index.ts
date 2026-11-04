import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { mailer } from "../email";
import { allowSignUpCode, authRateLimits, firstUseOfCode } from "../rate-limit";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

/**
 * The issuer is permanent and apps compare it, so it comes from settings and never from a request's
 * Host header, which whoever sends the request controls. Both values have to be set on purpose, so
 * a deployment that has not set them up has no provider rather than a wrong one.
 */
const oidc =
	baseURL && env.OIDC_PAIRWISE_SECRET
		? { issuer: new URL(baseURL).origin, pairwiseSecret: env.OIDC_PAIRWISE_SECRET }
		: undefined;

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The isolate's one Better Auth instance, built on first use. Better Auth starts resolving its
 * context as soon as it is created, and workerd forbids I/O in global scope, so a plugin that
 * touches the database while doing so would log an error on every cold start.
 */
export function getAuth() {
	instance ??= buildAuth();
	return instance;
}

/** Turnstile needs both keys, so one without the other leaves it off everywhere at once. */
const turnstile =
	env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
		? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY }
		: undefined;

function buildAuth() {
	return createAuth({
		db,
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		github:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
				: undefined,
		mailer,
		runInBackground: waitUntil,
		rateLimitStorage: authRateLimits,
		allowSignUpCode,
		firstUseOfCode,
		turnstileSecretKey: turnstile?.secretKey,
		checkBreachedPasswords: env.CHECK_BREACHED_PASSWORDS === "1",
		oidc,
	});
}

export const oidcEnabled = Boolean(oidc);

export const passkeysEnabled = Boolean(baseURL);

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer);

export const turnstileSiteKey = turnstile?.siteKey;
