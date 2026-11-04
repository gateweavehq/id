import type { ReactNode } from "react";
import { linkExpired, restartHref, type Search } from "#/lib/oauth-flow";

/**
 * What to say when a request from a page fails. When the page's signature has run out no attempt can
 * work, so instead of a provider's error it offers the way out: asking again as the app first did.
 */
export function failureMessage(error: { message?: string | undefined }, search: Search): ReactNode {
	if (!linkExpired(error)) return error.message ?? "Something went wrong";
	return (
		<>
			This page has been open too long.{" "}
			{/* Not a router link: the provider answers this, and not a page. */}
			<a href={restartHref(search)} className="font-medium underline underline-offset-4">
				Start again
			</a>
		</>
	);
}
