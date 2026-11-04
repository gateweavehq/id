import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { GitHubSignIn } from "#/components/github-sign-in";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import { useTurnstile } from "#/lib/turnstile";

const signUpSearch = z.object({
	/** Where to go once the account is set up. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field. */
	email: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/signup")({
	validateSearch: signUpSearch,
	beforeLoad: async ({ search }) => {
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/account" });
	},
	loader: () => getAuthOptions(),
	component: SignUpPage,
});

function SignUpPage() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/account";
	const router = useRouter();
	/** Who asked for a code, once one is on its way. */
	const [person, setPerson] = useState<{ name: string; email: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);
	useDocumentTitle("Create your account");

	/** Sends a code, and returns what went wrong if it did. */
	async function sendCode(email: string): Promise<string | null> {
		try {
			const result = await authClient.emailOtp.sendVerificationOtp({
				email,
				type: "sign-in",
				fetchOptions: { headers: await turnstile.check() },
			});
			return result.error ? (result.error.message ?? "Something went wrong") : null;
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
			setError(result.error.message ?? "Something went wrong");
			return;
		}
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

	if (!options.email) {
		return (
			<AuthPage
				title="Create your account"
				description="This server does not send email, so it cannot check an address. Ask whoever runs it for an invitation."
			>
				{options.github && <GitHubSignIn next={next} />}
				<BackToSignIn redirect={search.redirect} />
			</AuthPage>
		);
	}

	if (person) {
		return (
			<AuthPage
				title="Enter the code"
				description={
					<>
						We sent a code to <span className="text-foreground">{person.email}</span>. It works for
						10 minutes. If that address already has an account, the email says so instead, and you
						can sign in.
					</>
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
					<Button type="submit" className="w-full" disabled={pending}>
						Create account
					</Button>
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
				</div>

				{options.github && <GitHubSignIn next={next} />}

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
					<Button type="submit" className="w-full" disabled={pending}>
						Send me a code
					</Button>
				</form>

				<BackToSignIn redirect={search.redirect} />
			</div>
		</main>
	);
}

function BackToSignIn({ redirect }: { redirect: string | undefined }) {
	return (
		<p className="text-center text-sm text-muted-foreground">
			Already have an account?{" "}
			<Link
				to="/login"
				search={{ redirect }}
				className="font-medium text-foreground underline-offset-4 hover:underline"
			>
				Sign in
			</Link>
		</p>
	);
}
