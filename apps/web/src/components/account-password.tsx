import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

/**
 * A person with a password changes it here. Someone who signs in with GitHub, or who left before
 * choosing one when they signed up, adds their first here.
 */
export function AccountPassword({ email, hasPassword }: { email: string; hasPassword: boolean }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const element = event.currentTarget;
		const form = new FormData(element);
		const newPassword = String(form.get("password"));
		if (newPassword !== String(form.get("confirm"))) {
			setError("The passwords do not match");
			setNotice(null);
			return;
		}
		setPending(true);
		setError(null);
		setNotice(null);
		const result = hasPassword
			? await authClient.changePassword({
					currentPassword: String(form.get("current")),
					newPassword,
					// Whoever knew the old password may be why it is changing.
					revokeOtherSessions: true,
				})
			: await authClient.$fetch("/account/first-password", {
					method: "POST",
					body: { newPassword },
				});
		setPending(false);
		if (result.error) {
			setError(
				"code" in result.error && result.error.code === "SESSION_NOT_FRESH"
					? 'You signed in a while ago. Sign out and sign in again, then add your password here, or use "Forgot password?" on the sign-in page.'
					: (result.error.message ?? "Something went wrong"),
			);
			return;
		}
		element.reset();
		setNotice(
			hasPassword
				? "Your password is changed, and your other devices are signed out."
				: "Your password is set. You can sign in with it from now on.",
		);
		await router.invalidate();
	}

	return (
		<section aria-labelledby="password-heading" className="space-y-4">
			<h2 id="password-heading" className="text-sm font-semibold">
				Password
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				{!hasPassword && (
					<p className="text-sm text-muted-foreground">
						This account has no password yet. Add one to sign in with your email address.
					</p>
				)}
				{/* Tells a password manager which account this password belongs to. */}
				<input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
				{hasPassword && (
					<div className="space-y-2">
						<Label htmlFor="current">Current password</Label>
						<Input
							id="current"
							name="current"
							type="password"
							autoComplete="current-password"
							required
						/>
					</div>
				)}
				<div className="space-y-2">
					<Label htmlFor="password">New password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						minLength={8}
						autoComplete="new-password"
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
				{notice && (
					<p role="status" className="text-sm text-muted-foreground">
						{notice}
					</p>
				)}
				<Button type="submit" variant="outline" size="sm" disabled={pending}>
					{hasPassword ? "Change password" : "Add password"}
				</Button>
			</form>
		</section>
	);
}
