import { createFileRoute, redirect } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { getAppToAllow } from "#/lib/oauth-app";
import { flowSearch, onItsWay } from "#/lib/oauth-flow";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

const consentSearch = z.looseObject({
	client_id: z.string().max(200).optional().catch(undefined),
	scope: z.string().optional().catch(undefined),
});

/** What each scope lets an app have, in the words of the person it is about. */
const SCOPES: Record<string, string> = {
	profile: "See your name and picture",
	email: "See your email address",
	offline_access: "Keep you signed in while you are away",
};

function scopeWords(scope: string | undefined): string[] {
	return (scope ?? "").split(" ").flatMap((name) => {
		const words = Object.hasOwn(SCOPES, name) ? SCOPES[name] : undefined;
		return words ? [words] : [];
	});
}

/**
 * Asks whether an app may have what it asked for. First-party apps only come here when they ask to,
 * with `prompt=consent`. Apps a workspace adds always do, the first time, and this says whose they are
 * and where they go, as their names are whatever an admin chose. What this page shows is not what is
 * decided: the answer goes back with the signed query, and the provider reads that alone.
 */
export const Route = createFileRoute("/consent")({
	validateSearch: consentSearch,
	beforeLoad: async ({ search }) => {
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: flowSearch(search) });
		return { session };
	},
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({ deps }) => {
		const about = deps.clientId ? await getAppToAllow({ data: deps.clientId }) : null;
		// Someone with another person's link has nothing to answer, as either answer would send them to it.
		if (!about) throw redirect({ to: "/no-access" });
		return about;
	},
	component: ConsentPage,
});

function ConsentPage() {
	const { session } = Route.useRouteContext();
	const about = Route.useLoaderData();
	const search = Route.useSearch();
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	const app = about.name ?? "This app";
	const scopes = scopeWords(search.scope);
	useDocumentTitle("Allow access");

	async function answer(accept: boolean) {
		setPending(true);
		setError(null);
		const result = await authClient.$fetch("/oauth2/consent", {
			method: "POST",
			body: { accept },
		});
		if (onItsWay(result.data)) return;
		setPending(false);
		setError(failureMessage(result.error ?? {}, search));
	}

	return (
		<AuthPage
			title={`Allow ${app} to use your account?`}
			description={
				<>
					You are signed in as <span className="text-foreground">{session.user.email}</span>.
				</>
			}
		>
			{scopes.length > 0 && (
				<ul className="list-disc space-y-1 pl-5 text-sm">
					{scopes.map((words) => (
						<li key={words}>{words}</li>
					))}
				</ul>
			)}
			{about.workspace && (
				<p className="text-sm text-muted-foreground">
					An admin of <span className="text-foreground">{about.workspace}</span> added this app.
					Nobody has checked who runs it, so allow it only if you know what it is.
				</p>
			)}
			{about.host && (
				<p className="text-sm text-muted-foreground">
					Your answer takes you to <span className="text-foreground">{about.host}</span>.
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex gap-3">
				<LiveButton className="flex-1" disabled={pending} onClick={() => answer(true)}>
					Allow
				</LiveButton>
				<LiveButton
					variant="outline"
					className="flex-1"
					disabled={pending}
					onClick={() => answer(false)}
				>
					Deny
				</LiveButton>
			</div>
		</AuthPage>
	);
}
