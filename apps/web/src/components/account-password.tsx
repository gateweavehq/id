import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
	AccountCard,
	CARD_ACTION_ROW,
	CARD_FORM,
	CARD_ROW,
	useFocusBack,
} from "#/components/account-section";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

const NOT_SAVED = "Your password could not be saved. Please try again.";

/** The library's words for these are about a request, and these are about what the person did. */
function failureOf(error: object & { message?: string | undefined }): string {
	const code = "code" in error ? error.code : undefined;
	if (code === "INVALID_PASSWORD") return "That password is wrong.";
	if (code === "SESSION_NOT_FRESH") {
		return 'You signed in a while ago. Sign out and sign in again, then add your password here, or use "Forgot password?" on the sign-in page.';
	}
	return error.message ?? NOT_SAVED;
}

/**
 * A person with a password changes it here. Someone who signs in with GitHub, or who left before
 * choosing one when they signed up, adds their first here. Either way it is a row until they ask,
 * since most visits to this page are not about the password.
 */
export function AccountPassword({ email, hasPassword }: { email: string; hasPassword: boolean }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const opener = useFocusBack<HTMLButtonElement>(open);

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
		try {
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
			if (result.error) {
				setError(failureOf(result.error));
				return;
			}
			setNotice(
				hasPassword
					? "Your password is changed, and your other devices are signed out."
					: "Your password is set. You can sign in with it from now on.",
			);
			setOpen(false);
			await router.invalidate();
		} catch {
			setError(NOT_SAVED);
		} finally {
			setPending(false);
		}
	}

	return (
		<AccountCard id="password-heading" title="Password">
			{/* In the page from the start, and outside what opens and closes, or a screen reader would
			    not hear it arrive: a region that appears with its words in it is often not announced. */}
			<p aria-live="polite" className={notice ? `${CARD_ROW} text-muted-foreground` : "sr-only"}>
				{notice}
			</p>
			{open ? (
				// A mistake is about what was typed, so it goes once that changes.
				<form onSubmit={onSubmit} onChange={() => setError(null)} className={CARD_FORM}>
					{/* Tells a password manager which account this password belongs to. */}
					<input
						type="email"
						name="username"
						autoComplete="username"
						value={email}
						readOnly
						hidden
					/>
					{hasPassword && (
						<div className="space-y-2">
							<Label htmlFor="current">Current password</Label>
							<Input
								id="current"
								name="current"
								type="password"
								autoComplete="current-password"
								autoFocus
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
							aria-describedby="password-hint"
							autoFocus={!hasPassword}
							required
						/>
						<p id="password-hint" className="text-xs text-muted-foreground">
							{hasPassword
								? "At least 8 characters. Changing it signs you out on your other devices."
								: "At least 8 characters."}
						</p>
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
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
							{pending ? "Saving…" : "Save password"}
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={pending}
							onClick={() => {
								setOpen(false);
								setError(null);
							}}
						>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<div className={CARD_ACTION_ROW}>
					<p className="text-muted-foreground">
						{hasPassword
							? "You have a password. Changing it signs you out on your other devices."
							: "This account has no password."}
					</p>
					<LiveButton
						ref={opener}
						variant="outline"
						size="sm"
						onClick={() => {
							setNotice(null);
							setOpen(true);
						}}
					>
						{hasPassword ? "Change password" : "Add password"}
					</LiveButton>
				</div>
			)}
		</AccountCard>
	);
}
