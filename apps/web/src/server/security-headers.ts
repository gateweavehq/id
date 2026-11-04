const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** A new value for every response, so a script tag injected into a page cannot guess it. */
export function newNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes));
}

/**
 * What a page of ID may load. ID's pages take passwords and send people on to other apps with
 * tokens, so a script that got in would be the worst thing that could happen here, and nothing but
 * ID may frame them.
 *
 * Styles stay at `'unsafe-inline'`: Radix sets `style` attributes and Sonner adds a style tag, and
 * a style cannot run code the way a script can.
 */
export function contentSecurityPolicy(nonce: string, { turnstile }: { turnstile: boolean }) {
	const challenges = turnstile ? ` ${TURNSTILE_ORIGIN}` : "";
	return [
		"default-src 'none'",
		`script-src 'self' 'nonce-${nonce}'${challenges}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		`frame-src${challenges || " 'none'"}`,
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	].join("; ");
}

/** Adds the headers every response gets, and the ones a page gets, to what the app answered. */
export function withSecurityHeaders(
	request: Request,
	response: Response,
	{ nonce, turnstile }: { nonce: string; turnstile: boolean },
): Response {
	const secured = new Response(response.body, response);
	const { headers } = secured;
	headers.set("X-Content-Type-Options", "nosniff");
	// The reset page's token is in its URL. This keeps paths and queries from other sites, and
	// Turnstile still sees the origin it checks against the widget's domains.
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	if (new URL(request.url).protocol === "https:") {
		// Not `includeSubDomains`: on a self-hosted deployment those hosts are someone else's.
		headers.set("Strict-Transport-Security", "max-age=31536000");
	}
	if (headers.get("Content-Type")?.startsWith("text/html")) {
		headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, { turnstile }));
		// For browsers that predate `frame-ancestors`.
		headers.set("X-Frame-Options", "DENY");
		// The page carries this response's nonce, and what it shows depends on who is signed in.
		headers.set("Cache-Control", "private, no-store");
	}
	return secured;
}
