import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { workspaceFailure } from "#/lib/workspace";

/**
 * Asks for the password where there is one, which the server insists on. An account without one types
 * its address, which guards only against a slip: for those, a recent session is all the proof there is.
 */
export function AccountDelete({
	email,
	hasPassword,
	onDeleted,
}: {
	email: string;
	hasPassword: boolean;
	onDeleted: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setError(null);
		if (!hasPassword && String(form.get("address")).trim().toLowerCase() !== email.toLowerCase()) {
			setError("That is not the address of this account.");
			return;
		}
		setPending(true);
		const result = await authClient.$fetch("/account/delete", {
			method: "POST",
			body: hasPassword ? { password: String(form.get("password")) } : {},
		});
		setPending(false);
		if (result.error) {
			setError(workspaceFailure(result.error));
			return;
		}
		onDeleted();
	}

	return (
		<section aria-labelledby="delete-heading" className="space-y-4">
			<h2 id="delete-heading" className="text-sm font-semibold">
				Delete account
			</h2>
			{open ? (
				<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">
						This removes your account and takes you out of your workspaces. It cannot be undone.
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						<li>
							Apps you signed in to keep what they already hold about you, so delete your account in
							each of them too.
						</li>
						<li>Workspaces keep the apps you added to them.</li>
						<li>Invitations you sent that nobody has taken stop working.</li>
						<li>The record of what happened on this account stays for 90 days, then goes.</li>
					</ul>
					{hasPassword ? (
						<>
							{/* Tells a password manager which account this password belongs to. */}
							<input
								type="email"
								name="username"
								autoComplete="username"
								value={email}
								readOnly
								hidden
							/>
							<div className="space-y-2">
								<Label htmlFor="delete-password">Your password</Label>
								<Input
									id="delete-password"
									name="password"
									type="password"
									autoComplete="current-password"
									required
								/>
							</div>
						</>
					) : (
						<div className="space-y-2">
							<Label htmlFor="delete-address">Type your email address to confirm</Label>
							<Input id="delete-address" name="address" type="email" autoComplete="off" required />
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="destructive" size="sm" disabled={pending}>
							Delete my account
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false);
								setError(null);
							}}
						>
							Keep it
						</Button>
					</div>
				</form>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">Remove this account for good.</p>
					<LiveButton variant="outline" size="sm" onClick={() => setOpen(true)}>
						Delete account
					</LiveButton>
				</div>
			)}
		</section>
	);
}
