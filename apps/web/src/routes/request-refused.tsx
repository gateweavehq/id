import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { requestRefusal } from "#/lib/sign-in-refusal";
import { useDocumentTitle } from "#/lib/title";

/**
 * Where a request ends when the provider cannot trust the address it would send someone back to. Going
 * there anyway is how a link to this server becomes a link to anywhere (RFC 6749, section 4.1.2.1). Only
 * words of ours, never the `error_description` beside the code: anyone can make a link.
 */
export const Route = createFileRoute("/request-refused")({
	validateSearch: z.looseObject({ error: z.string().optional().catch(undefined) }),
	component: RequestRefusedPage,
});

function RequestRefusedPage() {
	const { error } = Route.useSearch();
	useDocumentTitle("Request refused");
	return (
		<AuthPage
			title="This request was refused"
			description={requestRefusal(error) ?? "This server could not answer that request."}
		>
			<p className="text-center text-sm text-muted-foreground">
				<Link to="/account" className="underline-offset-4 hover:text-foreground hover:underline">
					Go to your account
				</Link>
			</p>
		</AuthPage>
	);
}
