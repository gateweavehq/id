import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Better Auth checks the emailed link and sends the browser here with the token, or with an
// error when the link is used up or expired. A link from the owner of a server that sends no email
// comes straight here with the token after the #, which a browser sends to nobody.
const resetSearch = z.object({
	token: z.string().optional().catch(undefined),
	error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/reset-password")({
	validateSearch: resetSearch,
	beforeLoad: ({ search }) => {
		if (carriesASignature(search)) {
			throw redirect({
				to: "/reset-password",
				search: { token: search.token, error: search.error },
			});
		}
	},
	// The token is in this page's URL, so it must not travel on as a referrer.
	head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
	loader: () => getAuthOptions(),
	component: ResetPasswordPage,
});

function ResetPasswordPage() {
	const options = Route.useLoaderData();
	const { token: emailed, error: linkError } = Route.useSearch();
	// Only the browser can read it, so until this has run there is nothing to say about the link.
	const [passedOn, setPassedOn] = useState<string | null | undefined>(undefined);
	const token = emailed ?? passedOn;
	const [expired, setExpired] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useDocumentTitle("Choose a new password");

	useEffect(() => {
		setPassedOn(window.location.hash.slice(1) || null);
	}, []);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token) return;
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password"));
		if (password !== String(form.get("confirm"))) {
			setError("The passwords do not match");
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.resetPassword({ newPassword: password, token });
		setPending(false);
		if (result.error) {
			if (result.error.code === "INVALID_TOKEN") setExpired(true);
			else setError(result.error.message ?? "Something went wrong");
			return;
		}
		setDone(true);
	}

	if (done) {
		return (
			<AuthPage
				title="Password changed"
				description="You were signed out on every device. Sign in with your new password."
			>
				<Button asChild className="w-full">
					<Link to="/login">Sign in</Link>
				</Button>
			</AuthPage>
		);
	}

	if (token === undefined && !linkError) {
		return (
			<AuthPage title="Choose a new password">
				<p className="text-sm text-muted-foreground">Reading your link…</p>
			</AuthPage>
		);
	}

	if (!token || linkError || expired) {
		if (!options.email) {
			return (
				<AuthPage
					title="This link no longer works"
					description="It works once, for 24 hours. Ask whoever runs this server for another."
				>
					<Button asChild className="w-full">
						<Link to="/login">Back to sign in</Link>
					</Button>
				</AuthPage>
			);
		}
		return (
			<AuthPage
				title="This link no longer works"
				description="A reset link works once, for one hour. Ask for a new one."
			>
				<Button asChild className="w-full">
					<Link to="/forgot-password">Send a new link</Link>
				</Button>
			</AuthPage>
		);
	}

	return (
		<AuthPage title="Choose a new password">
			<form onSubmit={onSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="password">New password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						minLength={8}
						autoComplete="new-password"
						autoFocus
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="confirm">Repeat it</Label>
					<Input
						id="confirm"
						name="confirm"
						type="password"
						minLength={8}
						autoComplete="new-password"
						required
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" className="w-full" disabled={pending}>
					Change password
				</LiveButton>
			</form>
		</AuthPage>
	);
}
