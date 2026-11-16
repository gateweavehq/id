import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
	AccountCard,
	CARD_ACTION_ROW,
	CARD_FORM,
	useFocusBack,
} from "#/components/account-section";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { type DeleteAccountCheck, onlyOwnerWords, RUNS_THE_SERVER } from "#/lib/delete-account";
import { workspaceFailure } from "#/lib/workspace";

const NOT_CHECKED = "This could not be checked just now. Please try again.";
const NOT_DELETED = "Your account could not be deleted. Please try again.";

/** Where the card is: at rest, asking the server, held up by something, or asking for the proof. */
type Step =
	| { name: "resting" }
	| { name: "checking" }
	| { name: "held"; by: DeleteAccountCheck }
	| { name: "asking" };

/**
 * Asks for the password where there is one, which the server insists on. An account without one types
 * its address, which guards only against a slip: for those, a recent session is all the proof there is.
 *
 * Before it asks for either, it asks the server what would stop this, and says so in place of the
 * form: someone who is the only owner of a workspace used to give their password to find that out.
 * The server asks itself the same again when it deletes.
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
	const [step, setStep] = useState<Step>({ name: "resting" });
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// What opens takes the button's place, and gives the focus back to it on closing.
	const opener = useFocusBack<HTMLButtonElement>(step.name === "held" || step.name === "asking");

	async function open() {
		setError(null);
		setStep({ name: "checking" });
		try {
			const result = await authClient.$fetch<DeleteAccountCheck>("/account/delete/check");
			if (result.error) {
				setError(result.error.message ?? NOT_CHECKED);
				setStep({ name: "resting" });
				return;
			}
			const held = result.data.runsServer || result.data.onlyOwnerOf.length > 0;
			setStep(held ? { name: "held", by: result.data } : { name: "asking" });
		} catch {
			setError(NOT_CHECKED);
			setStep({ name: "resting" });
		}
	}

	function close() {
		setStep({ name: "resting" });
		setError(null);
	}

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setError(null);
		if (!hasPassword && String(form.get("address")).trim().toLowerCase() !== email.toLowerCase()) {
			setError("That is not the address of this account.");
			return;
		}
		setPending(true);
		try {
			const result = await authClient.$fetch("/account/delete", {
				method: "POST",
				body: hasPassword ? { password: String(form.get("password")) } : {},
			});
			if (result.error) {
				setError(workspaceFailure(result.error));
				return;
			}
			onDeleted();
		} catch {
			setError(NOT_DELETED);
		} finally {
			setPending(false);
		}
	}

	return (
		<AccountCard
			id="delete-heading"
			title="Delete account"
			level={2}
			danger
			aside={<span className="text-xs font-medium text-destructive">Cannot be undone</span>}
		>
			{step.name === "held" && (
				<div className={CARD_FORM}>
					<p className="font-medium">This account cannot be deleted yet.</p>
					{step.by.runsServer && <p className="text-muted-foreground">{RUNS_THE_SERVER.message}</p>}
					{step.by.onlyOwnerOf.length > 0 && (
						<>
							<p className="text-muted-foreground">
								{onlyOwnerWords(step.by.onlyOwnerOf.map(({ name }) => name))}
							</p>
							<ul aria-label="Workspaces that need another owner" className="space-y-1">
								{step.by.onlyOwnerOf.map((workspace) => (
									<li key={workspace.slug}>
										<Link
											to="/workspaces/$slug"
											params={{ slug: workspace.slug }}
											className="break-words font-medium underline underline-offset-4"
										>
											Open {workspace.name}
										</Link>
									</li>
								))}
							</ul>
						</>
					)}
					{/* Nothing here deletes anything, so this is all there is to press. */}
					<Button type="button" variant="outline" size="sm" autoFocus onClick={close}>
						Close
					</Button>
				</div>
			)}

			{step.name === "asking" && (
				// A mistake is about what was typed, so it goes once that changes.
				<form onSubmit={onSubmit} onChange={() => setError(null)} className={CARD_FORM}>
					<p className="text-sm text-muted-foreground">
						This removes your account and takes you out of your workspaces. It cannot be undone.
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						<li>
							Apps you signed in to keep what they already hold about you, and some may keep you
							signed in for a while, so delete your account in each of them too.
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
									autoFocus
									required
								/>
							</div>
						</>
					) : (
						<div className="space-y-2">
							<Label htmlFor="delete-address">Type your email address to confirm</Label>
							<Input
								id="delete-address"
								name="address"
								type="email"
								autoComplete="off"
								autoFocus
								required
							/>
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="destructive" size="sm" disabled={pending}>
							{pending ? "Deleting…" : "Delete my account"}
						</LiveButton>
						<Button type="button" variant="ghost" size="sm" disabled={pending} onClick={close}>
							Keep it
						</Button>
					</div>
				</form>
			)}

			{(step.name === "resting" || step.name === "checking") && (
				<>
					{error && (
						<p role="alert" className="px-4 py-3 text-destructive">
							{error}
						</p>
					)}
					<div className={CARD_ACTION_ROW}>
						<p className="text-muted-foreground">Remove this account for good.</p>
						{/* Not disabled while it checks, which would take the focus from whoever pressed it. */}
						<LiveButton
							ref={opener}
							variant="outline"
							size="sm"
							aria-disabled={step.name === "checking"}
							onClick={() => {
								if (step.name === "resting") open();
							}}
						>
							{step.name === "checking" ? "Checking…" : "Delete account"}
						</LiveButton>
					</div>
				</>
			)}
		</AccountCard>
	);
}
