// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/**
		 * Public URL of the app. Inferred from the request when unset. Its origin is the OIDC issuer,
		 * which apps compare, so it cannot change once any app signs anyone in.
		 */
		BETTER_AUTH_URL?: string;
		/**
		 * Gives each app its own id for each person, so that two apps cannot match up their users.
		 * With BETTER_AUTH_URL it turns on the OIDC provider. At least 32 characters. Rotating it
		 * gives everybody a new id in every app, so it is generated once and kept for good.
		 */
		OIDC_PAIRWISE_SECRET?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * Who email comes from, such as `Gateweave ID <id@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset, and then there are no
		 * sign-up codes and no password reset, which leaves GitHub as the only way to an account.
		 */
		EMAIL_FROM?: string;
		/**
		 * Cloudflare Turnstile, in front of sending email and password sign-in. Both or it stays off.
		 * Set both on a deployment open to the internet.
		 */
		TURNSTILE_SITE_KEY?: string;
		TURNSTILE_SECRET_KEY?: string;
		/**
		 * `"1"` refuses passwords known from breaches. This sends the first five characters of a
		 * password's SHA-1 to Have I Been Pwned, so a deployment has to choose it.
		 */
		CHECK_BREACHED_PASSWORDS?: string;
		/**
		 * The addresses of this deployment's legal pages, linked from the sign-in pages, the page that
		 * asks to allow an app, and the account and workspace pages. Each is left out when unset, or
		 * when it is not an http(s) address.
		 */
		LEGAL_NOTICE_URL?: string;
		PRIVACY_POLICY_URL?: string;
		TERMS_URL?: string;
		/** Seconds before a missed back-channel logout is first tried again. 60 unless set (tests). */
		LOGOUT_RETRY_SECONDS?: string;
	}
}
