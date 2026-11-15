import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { getSecondFactorAsked } from "#/lib/oauth-app";
import { flowSearch, inFlow, onItsWay, signInAgainHref } from "#/lib/oauth-flow";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

/**
 * Where a member ends up when their workspace asks for two-factor sign-in and they signed in with
 * less. Unlike `/no-access`, there is something they can do, so this says what counts and leads to
 * it. Like that page it keeps nobody out: the check runs at authorization and again at every token.
 */
export const Route = createFileRoute("/second-factor")({
	validateSearch: z.looseObject({
		client_id: z.string().max(200).optional().catch(undefined),
		redirect_uri: z.string().optional().catch(undefined),
	}),
	beforeLoad: async ({ search }) => {
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: flowSearch(search) });
		return { session };
	},
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({ deps, location }) => {
		const asked = deps.clientId ? await getSecondFactorAsked({ data: deps.clientId }) : null;
		// Not someone this app would admit, or a workspace that asks for nothing: the page that names
		// no app is the one for them, and it is the same page, so neither can be told from the other.
		if (!asked) throw redirect({ to: "/no-access", search: flowSearch(location.search) });
		return asked;
	},
	component: SecondFactorPage,
});

function SecondFactorPage() {
	const { session } = Route.useRouteContext();
	const search = Route.useSearch();
	const asked = Route.useLoaderData();
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	const flow = inFlow(search);
	const app = asked.app ?? "this app";
	const host =
		search.redirect_uri && URL.canParse(search.redirect_uri)
			? new URL(search.redirect_uri).host
			: null;
	useDocumentTitle("Two-factor sign-in needed");

	/** Sends an answer to the provider, which says where to go next. */
	async function tell(path: string, body: object) {
		setPending(true);
		setError(null);
		const result = await authClient.$fetch(path, { method: "POST", body });
		if (onItsWay(result.data)) return;
		setPending(false);
		setError(failureMessage(result.error ?? {}, search));
	}

	if (!asked.owed) {
		return (
			<AuthPage
				title="You are signed in with two factors"
				description={`${asked.workspace} asks for that before anyone uses ${app}, and you have done it.`}
			>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{flow ? (
					<LiveButton
						className="w-full"
						disabled={pending}
						// Runs the check again, which is what decides.
						onClick={() => tell("/oauth2/continue", { postLogin: true })}
					>
						Continue to {app}
					</LiveButton>
				) : (
					<p className="text-sm text-muted-foreground">Go back to {app} and sign in again.</p>
				)}
			</AuthPage>
		);
	}

	return (
		<AuthPage
			title="Two-factor sign-in needed"
			description={
				<>
					{asked.workspace} asks everyone to sign in with a second factor before using {app}.{" "}
					<span className="text-foreground">{session.user.email}</span> is signed in without one.
				</>
			}
		>
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>
					A passkey counts. So does your password followed by a code from an authenticator app, or
					by a recovery code.
				</p>
				<p>
					Signing in with GitHub does not count by itself, even if GitHub asked you for a code: this
					server cannot see whether it did.
				</p>
				{asked.ready ? (
					<p>You have one of these set up, so sign in again with it.</p>
				) : (
					<p>
						You have neither yet. On your account page, add a passkey
						{asked.hasPassword
							? " or turn on two-factor sign-in"
							: ", or choose a password and then turn on two-factor sign-in"}
						. Then sign in to {app} again.
					</p>
				)}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="space-y-3">
				{asked.ready && flow ? (
					<Button asChild className="w-full">
						{/* Not a router link: the provider answers this, and asks them to sign in again. */}
						<a href={signInAgainHref(search)}>Sign in again</a>
					</Button>
				) : (
					<Button asChild className="w-full">
						<Link to="/account">Go to your account</Link>
					</Button>
				)}
				{flow && host && (
					<LiveButton
						variant="outline"
						className="w-full"
						disabled={pending}
						// Tells the app that nobody signed in, which is the one answer it can act on.
						onClick={() => tell("/oauth2/consent", { accept: false })}
					>
						Back to {host}
					</LiveButton>
				)}
			</div>
			{asked.ready && (
				<p className="text-center text-sm text-muted-foreground">
					<Link to="/account" className="underline-offset-4 hover:text-foreground hover:underline">
						Go to your account
					</Link>
				</p>
			)}
		</AuthPage>
	);
}
