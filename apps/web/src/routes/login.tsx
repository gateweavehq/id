import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { z } from "zod";
import { AskForAccess } from "#/components/ask-for-access";
import { failureMessage } from "#/components/expired-link";
import { GitHubSignIn } from "#/components/github-sign-in";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { PasskeySignIn } from "#/components/passkey-sign-in";
import { SignInDivider } from "#/components/sign-in-divider";
import { SignInProgress } from "#/components/sign-in-progress";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, owesACode } from "#/lib/oauth-flow";
import { safeRedirect } from "#/lib/redirect";
import { getAccessRequestUrl, getAuthOptions, getSession } from "#/lib/session";
import { takeWhenReady, useSignInBusy, useSignInLatch } from "#/lib/sign-in-latch";
import { requestRefusal, signInRefusal } from "#/lib/sign-in-refusal";
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
		// Signing in would not help, and someone signed in would be sent on with no word of what happened.
		if (requestRefusal(search.error)) {
			throw redirect({ to: "/request-refused", search: { error: search.error } });
		}
		// On the way to an app, someone signed in only comes here when the app wants them to sign in again.
		if (inFlow(search)) return;
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/account" });
	},
	loader: async () => {
		const [options, accessUrl] = await Promise.all([getAuthOptions(), getAccessRequestUrl()]);
		return { ...options, accessUrl };
	},
	component: SignInForm,
});

function SignInForm() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/account";
	const router = useRouter();
	const [refusal, setRefusal] = useState(() => signInRefusal(search.error));
	const [error, setError] = useState<ReactNode>(null);
	// One for the form, GitHub and the passkey together: see `lib/sign-in-latch`.
	const latch = useSignInLatch();
	const busy = useSignInBusy(latch);
	/** Whether the form is waiting for its check, which holds "Sign in" and nothing else. */
	const checking = useRef(false);
	const [waiting, setWaiting] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);
	const legal = useLegalLinks();

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (checking.current) return;
		const form = new FormData(event.currentTarget);
		setError(null);
		setRefusal(null);
		// The check that a person is there can ask them to click, or never answer. Only "Sign in" waits
		// for it: GitHub and the passkey go on working, and one of them started meanwhile drops this.
		let taken: Awaited<ReturnType<typeof takeWhenReady<Record<string, string>>>>;
		checking.current = true;
		setWaiting(true);
		try {
			taken = await takeWhenReady(latch, turnstile.check);
		} catch (caught) {
			// Its own words: what could not be checked, and what to do about it.
			setError(caught instanceof Error ? caught.message : "Something went wrong");
			return;
		} finally {
			checking.current = false;
			setWaiting(false);
		}
		if (!taken) return;
		// Taking the page ended the browser's offer of a passkey in the email field, which could
		// otherwise be answered while the password is on its way. A wrong password gives the page
		// back, and the offer too.
		const { attempt, value: headers } = taken;
		try {
			const result = await authClient.signIn.email({
				email: String(form.get("email")),
				password: String(form.get("password")),
				fetchOptions: { headers },
			});
			if (result.error) {
				setError(failureMessage(result.error, search));
				attempt.release();
				return;
			}
			// Everything from here leaves this page, and the latch stays taken until it has: the answer to
			// a redirect can be a while in coming, and a button that worked again meanwhile would start
			// a second sign-in beside the one that is finishing.
			attempt.leave();
			if (onItsWay(result.data)) return;
			if (owesACode(result.data)) {
				await router.navigate({
					to: "/two-factor",
					search: { redirect: search.redirect, ...flowSearch(search) },
				});
				return;
			}
		} catch {
			// The request was never answered. What the browser says about that is not for people.
			setError("Something went wrong");
			attempt.release();
			return;
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
							{options.github && <GitHubSignIn next={next} search={search} latch={latch} />}
							{options.passkeys && <PasskeySignIn next={next} search={search} latch={latch} />}
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
							// Without `webauthn` the browser's offer cannot start, and it must not while an
							// attempt has the page. One whose options were still on their way when the page
							// was taken starts only now, and would end the passkey button's own ceremony.
							autoComplete={options.passkeys && !busy ? "email webauthn" : "email"}
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
					<LiveButton type="submit" className="w-full" disabled={busy || waiting}>
						Sign in
					</LiveButton>
					<SignInProgress latch={latch} />
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

				<AskForAccess url={options.accessUrl} />

				<LegalLinks links={legal} agreeing />
			</div>
		</main>
	);
}
