import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { GitHubSignIn } from "#/components/github-sign-in";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";
import { useTurnstile } from "#/lib/turnstile";

const loginSearch = z.object({
	/** Where to go once signed in. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field. */
	email: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	beforeLoad: async ({ search }) => {
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
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError(null);
		try {
			const result = await authClient.signIn.email({
				email: String(form.get("email")),
				password: String(form.get("password")),
				fetchOptions: { headers: await turnstile.check() },
			});
			if (result.error) {
				setError(result.error.message ?? "Something went wrong");
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

				{options.github && <GitHubSignIn next={next} />}

				<form onSubmit={onSubmit} className="space-y-4">
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
					<Button type="submit" className="w-full" disabled={pending}>
						Sign in
					</Button>
				</form>

				<p className="text-center text-sm text-muted-foreground">
					New to Gateweave ID?{" "}
					<Link
						to="/signup"
						search={{ redirect: search.redirect }}
						className="font-medium text-foreground underline-offset-4 hover:underline"
					>
						Create an account
					</Link>
				</p>
			</div>
		</main>
	);
}
