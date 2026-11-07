import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { createDb } from "./server/db";
import { pruneExpired } from "./server/db/prune";
import { deliverMissedLogouts } from "./server/logouts";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { RateLimiter } from "./server/rate-limit";

const turnstile = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);

/**
 * A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run safely
 * without the database and the secret. So such a deployment serves nothing else.
 */
function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

export default {
	async fetch(request) {
		if (!env.DB || !env.BETTER_AUTH_SECRET) return notSetUp();
		const nonce = newNonce();
		const response = await handler.fetch(request, { context: { nonce } });
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, turnstile });
	},
	// A failure shows in the Worker's logs, and the next run picks up what this one left.
	async scheduled() {
		await pruneExpired(createDb(env.DB));
	},
	async queue(batch) {
		await deliverMissedLogouts(batch);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
