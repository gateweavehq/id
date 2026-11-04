// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * Who email comes from, such as `Gateweave ID <id@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset, and then there are no
		 * sign-up codes and no password reset, which leaves GitHub as the only way to an account.
		 */
		EMAIL_FROM?: string;
	}
}
