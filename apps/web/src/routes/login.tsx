import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { z } from "zod";
import { failureMessage } from "#/components/expired-link";
import { GitHubSignIn } from "#/components/github-sign-in";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { PasskeySignIn } from "#/components/passkey-sign-in";
import { SignInDivider } from "#/components/sign-in-divider";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, owesACode } from "#/lib/oauth-flow";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";
import { signInRefusal } from "#/lib/sign-in-refusal";
import { useTurnstile } from "#/lib/turnstile";

// Loose, because on the way to an app the query is the app's signed request. See `lib/oauth-flow`.
const loginSearch = z.looseObject({
	/** Where to go once signed in. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field. */
	email: z.string().optional().catch(undefined),
	/** Why a GitHub sign-in came back here. */
	error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	beforeLoad: async ({ search }) => {
		// On the way to an app, someone signed in only comes here when the app wants them to sign in again.
		if (inFlow(search)) return;
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/account" });
	},
	loader: () => getAuthOptions(),
	component: SignInForm,
});

function SignInForm() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/account";
	const router = useRouter();
	const [refusal, setRefusal] = useState(() => signInRefusal(search.error));
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);
	const legal = useLegalLinks();

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError(null);
		setRefusal(null);
		try {
			const result = await authClient.signIn.email({
				email: String(form.get("email")),
				password: String(form.get("password")),
				fetchOptions: { headers: await turnstile.check() },
			});
			if (result.error) {
				setError(failureMessage(result.error, search));
				return;
			}
			if (onItsWay(result.data)) return;
			if (owesACode(result.data)) {
				await router.navigate({
					to: "/two-factor",
					search: { redirect: search.redirect, ...flowSearch(search) },
				});
				return;
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Something went wrong");
			return;
		} finally {
			setPending(false);
		}
		await router.invalidate();
		await router.navigate({ href: next });
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5 text-center">
					<h1 className="text-xl font-semibold tracking-tight">Sign in to Gateweave ID</h1>
				</div>

				{refusal && (
					<p role="alert" className="text-sm text-destructive">
						{refusal}
					</p>
				)}

				{(options.github || options.passkeys) && (
					<>
						<div className="space-y-3">
							{options.github && <GitHubSignIn next={next} search={search} />}
							{options.passkeys && <PasskeySignIn next={next} search={search} />}
						</div>
						<SignInDivider />
					</>
				)}

				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete={options.passkeys ? "email webauthn" : "email"}
							defaultValue={search.email}
							required
						/>
					</div>
					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="password">Password</Label>
							{options.email && (
								<Link
									to="/forgot-password"
									search={{ email: search.email }}
									className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Forgot password?
								</Link>
							)}
						</div>
						<Input
							id="password"
							name="password"
							type="password"
							autoComplete="current-password"
							required
						/>
					</div>
					{turnstile.element}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<LiveButton type="submit" className="w-full" disabled={pending}>
						Sign in
					</LiveButton>
				</form>

				<p className="text-center text-sm text-muted-foreground">
					New to Gateweave ID?{" "}
					<Link
						to="/signup"
						search={{
							redirect: search.redirect,
							// On the way to an app, the query is the app's signed request and stays as it is.
							email: inFlow(search) ? undefined : search.email,
							...flowSearch(search),
						}}
						className="font-medium text-foreground underline-offset-4 hover:underline"
					>
						Create an account
					</Link>
				</p>

				<LegalLinks links={legal} agreeing />
			</div>
		</main>
	);
}
