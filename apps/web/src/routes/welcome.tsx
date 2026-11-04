import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/redirect";
import { getSession, hasPassword } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

const welcomeSearch = z.object({
	/** Where to go once there is a password. */
	redirect: z.string().optional().catch(undefined),
});

/**
 * The last step of signing up: the address is proven, so now a password can belong to the person
 * who proved it.
 */
export const Route = createFileRoute("/welcome")({
	validateSearch: welcomeSearch,
	beforeLoad: async ({ search }) => {
		const next = safeRedirect(search.redirect) ?? "/account";
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: { redirect: next } });
		if (await hasPassword()) throw redirect({ href: next });
		return { session, next };
	},
	component: WelcomePage,
});

function WelcomePage() {
	const { session, next } = Route.useRouteContext();
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useDocumentTitle("Choose a password");

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const newPassword = String(form.get("password"));
		if (newPassword !== String(form.get("confirm"))) {
			setError("The passwords do not match");
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.$fetch("/account/first-password", {
			method: "POST",
			body: { newPassword },
		});
		if (result.error) {
			setPending(false);
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		await router.navigate({ href: next });
	}

	return (
		<AuthPage
			title="Choose a password"
			description={
				<>
					You will use it to sign in as{" "}
					<span className="text-foreground">{session.user.email}</span>.
				</>
			}
		>
			<form onSubmit={onSubmit} className="space-y-4">
				{/* Tells a password manager which account this password belongs to. */}
				<input
					type="email"
					name="email"
					autoComplete="username"
					value={session.user.email}
					readOnly
					hidden
				/>
				<div className="space-y-2">
					<Label htmlFor="password">Password</Label>
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
				<Button type="submit" className="w-full" disabled={pending}>
					Continue
				</Button>
			</form>
		</AuthPage>
	);
}
