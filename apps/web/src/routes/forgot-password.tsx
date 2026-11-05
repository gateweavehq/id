import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import { useTurnstile } from "#/lib/turnstile";

export const Route = createFileRoute("/forgot-password")({
	validateSearch: z.object({ email: z.string().optional().catch(undefined) }),
	beforeLoad: ({ search }) => {
		if (carriesASignature(search)) {
			throw redirect({ to: "/forgot-password", search: { email: search.email } });
		}
	},
	loader: () => getAuthOptions(),
	component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useTurnstile(options.turnstileSiteKey);
	useDocumentTitle("Reset your password");

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const email = String(new FormData(event.currentTarget).get("email")).trim();
		setPending(true);
		setError(null);
		try {
			const result = await authClient.requestPasswordReset({
				email,
				redirectTo: "/reset-password",
				fetchOptions: { headers: await turnstile.check() },
			});
			if (result.error) {
				setError(result.error.message ?? "Something went wrong");
				return;
			}
			setSentTo(email);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	if (!options.email) {
		return (
			<AuthPage
				title="Reset your password"
				description="This server does not send email, so it cannot send you a reset link. Ask whoever runs it to help."
			>
				<BackToSignIn />
			</AuthPage>
		);
	}

	if (sentTo) {
		return (
			<AuthPage
				title="Check your email"
				description={
					<>
						If <span className="text-foreground">{sentTo}</span> has an account, we sent it a link
						to choose a new password. The link works for one hour.
					</>
				}
			>
				<BackToSignIn />
			</AuthPage>
		);
	}

	return (
		<AuthPage
			title="Reset your password"
			description="Enter the email address you sign in with. We will send it a link to choose a new password."
		>
			<form onSubmit={onSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						name="email"
						type="email"
						autoComplete="email"
						defaultValue={search.email}
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
				<LiveButton type="submit" className="w-full" disabled={pending}>
					Send reset link
				</LiveButton>
			</form>
			<BackToSignIn />
		</AuthPage>
	);
}

function BackToSignIn() {
	return (
		<p className="text-center text-sm text-muted-foreground">
			<Link to="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
				Back to sign in
			</Link>
		</p>
	);
}
