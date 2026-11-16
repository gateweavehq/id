import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AccountCard, CARD_FORM } from "#/components/account-section";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

export function AccountProfile({ name, email }: { name: string; email: string }) {
	const router = useRouter();
	const [value, setValue] = useState(name);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [pending, setPending] = useState(false);
	const next = value.trim();

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setSaved(false);
		// The server says the same. Spaces alone get past `required`, and need no trip to find out.
		if (!next) {
			setError("Enter a name.");
			return;
		}
		setPending(true);
		try {
			const result = await authClient.updateUser({ name: next });
			if (result.error) {
				setError(result.error.message ?? "Your name could not be saved. Please try again.");
				return;
			}
			// The top of the page says the name too, and that comes from the route.
			await router.invalidate();
			setValue(next);
			setSaved(true);
		} catch {
			setError("Your name could not be saved. Please try again.");
		} finally {
			setPending(false);
		}
	}

	return (
		<AccountCard id="details-heading" title="Your details">
			<form onSubmit={onSubmit} className={CARD_FORM}>
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						type="email"
						value={email}
						readOnly
						disabled
						aria-describedby="email-hint"
					/>
					<p id="email-hint" className="text-xs text-muted-foreground">
						Your address cannot be changed here.
					</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="name">Name</Label>
					<Input
						id="name"
						name="name"
						autoComplete="name"
						maxLength={100}
						value={value}
						// What is typed while a save is on its way would be replaced by what was sent.
						readOnly={pending}
						onChange={(event) => {
							setValue(event.target.value);
							setError(null);
							setSaved(false);
						}}
						required
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{saved && (
					<p role="status" className="text-sm text-muted-foreground">
						Saved.
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending || next === name}>
					{pending ? "Saving…" : "Save"}
				</LiveButton>
			</form>
		</AccountCard>
	);
}
