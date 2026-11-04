import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { mailer } from "../email";
import { authRateLimits } from "../rate-limit";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

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
	});
}

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer);
