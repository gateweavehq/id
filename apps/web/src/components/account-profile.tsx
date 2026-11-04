import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

export function AccountProfile({ name, email }: { name: string; email: string }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const next = String(new FormData(event.currentTarget).get("name")).trim();
		setPending(true);
		setError(null);
		setSaved(false);
		const result = await authClient.updateUser({ name: next });
		setPending(false);
		if (result.error) {
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		setSaved(true);
		await router.invalidate();
	}

	return (
		<section aria-labelledby="profile" className="space-y-4">
			<h2 id="profile" className="text-sm font-semibold">
				Profile
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input id="email" type="email" value={email} readOnly disabled />
				</div>
				<div className="space-y-2">
					<Label htmlFor="name">Name</Label>
					<Input
						id="name"
						name="name"
						autoComplete="name"
						maxLength={100}
						defaultValue={name}
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
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Save
				</LiveButton>
			</form>
		</section>
	);
}
