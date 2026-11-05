import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

export interface NewAccount {
	name: string;
	email: string;
	newPassword: string;
}

/**
 * An account's name and password in one go, for the ways in that have no code to wait for. `submit`
 * answers with what went wrong, and otherwise the form stays busy while the page moves on.
 */
export function NewAccountForm({
	askAddress = false,
	action,
	submit,
}: {
	askAddress?: boolean;
	action: string;
	submit: (person: NewAccount) => Promise<string | null>;
}) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

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
		const failure = await submit({
			name: String(form.get("name")).trim(),
			email: String(form.get("email") ?? "").trim(),
			newPassword,
		});
		if (failure) {
			setPending(false);
			setError(failure);
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="name">Name</Label>
				<Input id="name" name="name" autoComplete="name" maxLength={100} required />
			</div>
			{askAddress && (
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input id="email" name="email" type="email" autoComplete="email" required />
				</div>
			)}
			<div className="space-y-2">
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="new-password"
					minLength={8}
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="confirm">Repeat it</Label>
				<Input
					id="confirm"
					name="confirm"
					type="password"
					autoComplete="new-password"
					minLength={8}
					required
				/>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<LiveButton type="submit" className="w-full" disabled={pending}>
				{action}
			</LiveButton>
		</form>
	);
}
