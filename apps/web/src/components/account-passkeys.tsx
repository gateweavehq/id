import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useHydrated } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { nothingHappened, passkeyFailure } from "#/lib/passkey-errors";

interface ListedPasskey {
	id: string;
	name?: string | null | undefined;
	createdAt?: Date | string | null | undefined;
	backedUp: boolean;
}

/**
 * The passkeys that can sign this person in, where they can add, name and remove them. It loads in
 * the browser, as the sessions below it do, so that dates read in the person's own time zone.
 */
export function AccountPasskeys() {
	const hydrated = useHydrated();
	const [passkeys, setPasskeys] = useState<ListedPasskey[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	const load = useCallback(async () => {
		const result = await authClient.passkey.listUserPasskeys();
		if (result.error) {
			setError(result.error.message ?? "Your passkeys could not be loaded");
			return;
		}
		setPasskeys(result.data);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	async function add() {
		setAdding(true);
		setError(null);
		const result = await authClient.passkey.addPasskey();
		setAdding(false);
		if (result.error) {
			if (!nothingHappened(result.error)) setError(passkeyFailure(result.error));
			return;
		}
		await load();
	}

	return (
		<section aria-labelledby="passkeys-heading" className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h2 id="passkeys-heading" className="text-sm font-semibold">
					Passkeys
				</h2>
				{(!hydrated || browserSupportsWebAuthn()) && (
					<LiveButton variant="outline" size="sm" disabled={adding} onClick={add}>
						Add a passkey
					</LiveButton>
				)}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{passkeys === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : passkeys.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Sign in with your fingerprint, your face or your device's PIN, with nothing to type and
					nothing a fake site could ask you for.
				</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{passkeys.map((passkey) => (
						<PasskeyRow key={passkey.id} passkey={passkey} onChange={load} onError={setError} />
					))}
				</ul>
			)}
		</section>
	);
}

function PasskeyRow({
	passkey,
	onChange,
	onError,
}: {
	passkey: ListedPasskey;
	onChange: () => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [mode, setMode] = useState<"showing" | "renaming" | "removing">("showing");
	const [pending, setPending] = useState(false);
	const name = passkey.name || "Passkey";

	async function run(action: () => Promise<{ error: { message?: string | undefined } | null }>) {
		setPending(true);
		onError(null);
		const result = await action();
		setPending(false);
		if (result.error) {
			onError(passkeyFailure(result.error));
			setMode("showing");
			return;
		}
		await onChange();
		setMode("showing");
	}

	function rename(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget).get("name"));
		run(() => authClient.passkey.updatePasskey({ id: passkey.id, name: value }));
	}

	if (mode === "renaming") {
		return (
			<li className="px-4 py-3">
				<form onSubmit={rename} className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="min-w-0 flex-1 space-y-1.5">
						<Label htmlFor={`passkey-${passkey.id}`}>Name</Label>
						<Input
							id={`passkey-${passkey.id}`}
							name="name"
							defaultValue={name}
							maxLength={100}
							autoComplete="off"
							autoFocus
							required
						/>
					</div>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={pending}>
							Save
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={pending}
							onClick={() => setMode("showing")}
						>
							Cancel
						</Button>
					</div>
				</form>
			</li>
		);
	}

	return (
		<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
			<div className="min-w-0">
				<p className="break-words font-medium">{name}</p>
				<p className="text-xs text-muted-foreground">
					{passkey.createdAt &&
						`Added ${new Date(passkey.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
					{passkey.backedUp && " · Synced between your devices"}
				</p>
			</div>
			{mode === "removing" ? (
				<div className="flex shrink-0 items-center gap-2">
					<span className="text-xs text-muted-foreground">Remove it?</span>
					<Button
						variant="destructive"
						size="sm"
						disabled={pending}
						onClick={() =>
							run(() =>
								authClient.$fetch("/account/remove-passkey", {
									method: "POST",
									body: { id: passkey.id },
								}),
							)
						}
					>
						Remove
					</Button>
					<Button variant="ghost" size="sm" disabled={pending} onClick={() => setMode("showing")}>
						Keep
					</Button>
				</div>
			) : (
				<div className="flex shrink-0 gap-2">
					<Button variant="ghost" size="sm" onClick={() => setMode("renaming")}>
						Rename
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setMode("removing")}>
						Remove
					</Button>
				</div>
			)}
		</li>
	);
}
