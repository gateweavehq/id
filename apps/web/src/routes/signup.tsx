import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { GitHubSignIn } from "#/components/github-sign-in";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { NewAccountForm } from "#/components/new-account-form";
import { SignInDivider } from "#/components/sign-in-divider";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, type Search } from "#/lib/oauth-flow";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession, getSignUpState } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import { useTurnstile } from "#/lib/turnstile";

// Loose, because on the way to an app the query is the app's signed request. See `lib/oauth-flow`.
const signUpSearch = z.looseObject({
	/** Where to go once the account is set up. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field. */
	email: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/signup")({
	validateSearch: signUpSearch,
	beforeLoad: async ({ search }) => {
		// On the way to an app, someone signed in only comes here when the app wants them to sign in again.
		if (inFlow(search)) return;
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/account" });
	},
	loader: async () => {
		const [options, signUp] = await Promise.all([getAuthOptions(), getSignUpState()]);
		return { ...options, signUp };
	},
	component: SignUpPage,
});

function SignUpPage() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/account";
	const router = useRouter();
	/** Who asked for a code, once one is on its way. */
	const [person, setPerson] = useState<{ name: string; email: string } | null>(null);
	const [error, setError] = useState<ReactNode>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);
	const legal = useLegalLinks();
	useDocumentTitle("Create your account");

	/** Sends a code, and returns what went wrong if it did. */
	async function sendCode(email: string): Promise<ReactNode> {
		try {
			const result = await authClient.emailOtp.sendVerificationOtp({
				email,
				type: "sign-in",
				fetchOptions: { headers: await turnstile.check() },
			});
			return result.error ? failureMessage(result.error, search) : null;
		} catch (caught) {
			return caught instanceof Error ? caught.message : "Something went wrong";
		}
	}

	async function onAskForCode(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const email = String(form.get("email")).trim();
		const name = String(form.get("name")).trim();
		setPending(true);
		setError(null);
		const failure = await sendCode(email);
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		setPerson({ name, email });
	}

	async function onEnterCode(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!person) return;
		const otp = String(new FormData(event.currentTarget).get("code")).replace(/\s/g, "");
		setPending(true);
		setError(null);
		setNotice(null);
		const result = await authClient.signIn.emailOtp({ ...person, otp });
		if (result.error) {
			setPending(false);
			setError(failureMessage(result.error, search));
			return;
		}
		if (onItsWay(result.data)) return;
		// Not `router.invalidate()` first: this page sends people with a session straight to `next`,
		// which would flash past before the welcome page.
		await router.navigate({ to: "/welcome", search: { redirect: next } });
	}

	async function onSendAnother() {
		if (!person) return;
		setError(null);
		setNotice(null);
		const failure = await sendCode(person.email);
		if (failure) setError(failure);
		else setNotice("A new code is on its way. The last one no longer works.");
	}

	if (!options.email && options.signUp === "unclaimed") {
		return (
			<AuthPage
				agreeing
				title="Claim this server"
				description="It has no accounts yet. The first one owns it, and decides who else can join. This server does not send email, so nothing checks the address: use your real one."
			>
				{options.github && (
					<>
						<GitHubSignIn next={next} search={search} />
						<SignInDivider />
					</>
				)}
				<NewAccountForm
					askAddress
					action="Claim this server"
					submit={async (person) => {
						const result = await authClient.$fetch("/deployment/claim", {
							method: "POST",
							body: person,
						});
						if (result.error) return result.error.message ?? "Something went wrong";
						await router.navigate({ to: "/server" });
						return null;
					}}
				/>
			</AuthPage>
		);
	}

	if (!options.email) {
		return (
			<AuthPage
				agreeing
				title="Create your account"
				description="This server does not send email, so it cannot check an address. Ask whoever runs it for an invitation."
			>
				{options.github && (
					<>
						<GitHubSignIn next={next} search={search} />
						<SignInDivider />
					</>
				)}
				<BackToSignIn search={search} />
			</AuthPage>
		);
	}

	if (person) {
		return (
			<AuthPage
				agreeing
				title="Enter the code"
				description={
					options.signUp === "by-invitation" ? (
						<>
							If <span className="text-foreground">{person.email}</span> has an invitation, we sent
							it a code that works for 10 minutes. If it already has an account, the email says so
							instead, and you can sign in. If nothing comes, ask whoever runs this server to invite
							you.
						</>
					) : (
						<>
							We sent a code to <span className="text-foreground">{person.email}</span>. It works
							for 10 minutes. If that address already has an account, the email says so instead, and
							you can sign in.
						</>
					)
				}
			>
				<form onSubmit={onEnterCode} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="code">Code</Label>
						<Input
							id="code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9 ]*"
							maxLength={7}
							autoFocus
							required
						/>
					</div>
					{turnstile.element}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					{notice && (
						<p role="status" className="text-sm text-muted-foreground">
							{notice}
						</p>
					)}
					<LiveButton type="submit" className="w-full" disabled={pending}>
						Create account
					</LiveButton>
				</form>
				<div className="flex justify-between text-sm text-muted-foreground">
					<button
						type="button"
						className="underline-offset-4 hover:text-foreground hover:underline"
						onClick={onSendAnother}
					>
						Send another code
					</button>
					<button
						type="button"
						className="underline-offset-4 hover:text-foreground hover:underline"
						onClick={() => {
							setPerson(null);
							setError(null);
							setNotice(null);
						}}
					>
						Use another address
					</button>
				</div>
			</AuthPage>
		);
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5 text-center">
					<h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
					{options.signUp === "by-invitation" && (
						<p className="text-sm text-muted-foreground">
							This server takes new accounts by invitation. Use the address your invitation went to.
						</p>
					)}
					{options.signUp === "unclaimed" && (
						<p className="text-sm text-muted-foreground">
							This server has no accounts yet. The first one owns it, and decides who else can join.
						</p>
					)}
				</div>

				{options.github && (
					<>
						<GitHubSignIn next={next} search={search} />
						<SignInDivider />
					</>
				)}

				<form onSubmit={onAskForCode} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="name">Name</Label>
						<Input id="name" name="name" autoComplete="name" maxLength={100} required />
					</div>
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							defaultValue={search.email}
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
						Send me a code
					</LiveButton>
				</form>

				<BackToSignIn search={search} />

				<LegalLinks links={legal} agreeing />
			</div>
		</main>
	);
}

function BackToSignIn({ search }: { search: Search & { redirect?: string | undefined } }) {
	return (
		<p className="text-center text-sm text-muted-foreground">
			Already have an account?{" "}
			<Link
				to="/login"
				search={{ redirect: search.redirect, ...flowSearch(search) }}
				className="font-medium text-foreground underline-offset-4 hover:underline"
			>
				Sign in
			</Link>
		</p>
	);
}
