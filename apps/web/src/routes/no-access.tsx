import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, restartHref } from "#/lib/oauth-flow";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

/**
 * Where someone ends up when the check for who may sign in refuses them. The check runs again at
 * every token, so nothing here is what keeps them out: this page is only the explanation.
 */
export const Route = createFileRoute("/no-access")({
	validateSearch: z.looseObject({
		redirect_uri: z.string().optional().catch(undefined),
	}),
	beforeLoad: async ({ search }) => {
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: flowSearch(search) });
		return { session };
	},
	component: NoAccessPage,
});

function NoAccessPage() {
	const { session } = Route.useRouteContext();
	const search = Route.useSearch();
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	const flow = inFlow(search);
	const host =
		search.redirect_uri && URL.canParse(search.redirect_uri)
			? new URL(search.redirect_uri).host
			: null;
	useDocumentTitle("No access");

	async function onUseAnotherAccount() {
		setPending(true);
		const next = flow ? restartHref(search) : "/login";
		// The auth client would send the signed query along with signing out too, and the provider would
		// refuse it once it has run out, leaving someone unable to leave this page.
		window.history.replaceState(null, "", window.location.pathname);
		await authClient.signOut();
		window.location.assign(next);
	}

	/** Tells the app that nobody signed in, which is the one answer it can act on. */
	async function onGoBack() {
		setPending(true);
		setError(null);
		const result = await authClient.$fetch("/oauth2/consent", {
			method: "POST",
			body: { accept: false },
		});
		if (onItsWay(result.data)) return;
		setPending(false);
		setError(failureMessage(result.error ?? {}, search));
	}

	return (
		<AuthPage
			title="You do not have access"
			description={
				<>
					<span className="text-foreground">{session.user.email}</span> cannot use this app. If it
					should, ask whoever runs the app.
				</>
			}
		>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="space-y-3">
				<LiveButton className="w-full" disabled={pending} onClick={onUseAnotherAccount}>
					Use another account
				</LiveButton>
				{flow && host && (
					<LiveButton variant="outline" className="w-full" disabled={pending} onClick={onGoBack}>
						Back to {host}
					</LiveButton>
				)}
			</div>
			<p className="text-center text-sm text-muted-foreground">
				<Link to="/account" className="underline-offset-4 hover:text-foreground hover:underline">
					Go to your account
				</Link>
			</p>
		</AuthPage>
	);
}
