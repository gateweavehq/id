import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import {
	AccountCard,
	CARD_ROW,
	LoadFailure,
	ROW_BUTTON,
	useFocusBack,
	useLoaded,
} from "#/components/account-section";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { nothingHappened, passkeyFailure } from "#/lib/passkey-errors";
import { TWO_FACTORS_TO_ADD_A_PASSKEY } from "#/lib/sign-in-method";

/**
 * For someone with a passkey who signed in without one, who may neither add nor remove. The server
 * has a sentence for each, and two that differ by a word would read as a mistake.
 */
const TWO_FACTORS_TO_ADD_OR_REMOVE =
	"Sign in with your passkey or your authenticator code first, then add or remove a passkey.";

const NOT_LOADED = "Your passkeys could not be loaded";
const NOT_DONE = "That did not work. Please try again.";

interface ListedPasskey {
	id: string;
	name?: string | null | undefined;
	createdAt?: Date | string | null | undefined;
	backedUp: boolean;
}

const listPasskeys = () => authClient.passkey.listUserPasskeys();

/**
 * The passkeys that can sign this person in, where they can add, name and remove them. It loads in
 * the browser, as the sessions below it do, so that dates read in the person's own time zone.
 *
 * Someone who already has a second factor can only add a passkey from a sign-in that used one, and
 * only such a sign-in removes one. The server refuses any other, and this says so first, in place of
 * the buttons, where one that only failed would not.
 */
export function AccountPasskeys({
	twoFactorOn,
	signedInWithTwoFactors,
}: {
	/** Whether a password here is followed by a code from an authenticator. */
	twoFactorOn: boolean;
	/** Whether this session was made with a passkey, or a password and a code. */
	signedInWithTwoFactors: boolean;
}) {
	const hydrated = useHydrated();
	const router = useRouter();
	const {
		data: passkeys,
		failure,
		loading,
		reload,
	} = useLoaded<ListedPasskey[]>(listPasskeys, NOT_LOADED);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);

	/** The list again, and the count of them that the top of this part of the page gives. */
	async function changed() {
		await Promise.all([reload(), router.invalidate()]);
	}

	async function add() {
		setAdding(true);
		setError(null);
		try {
			const result = await authClient.passkey.addPasskey();
			if (result.error) {
				if (!nothingHappened(result.error)) setError(passkeyFailure(result.error));
				return;
			}
			await changed();
		} catch {
			setError(NOT_DONE);
		} finally {
			setAdding(false);
		}
	}

	const canUsePasskeys = !hydrated || browserSupportsWebAuthn();
	const hasPasskeys = passkeys !== null && passkeys.length > 0;
	const signInFirst = !signedInWithTwoFactors && (twoFactorOn || hasPasskeys);

	return (
		<AccountCard
			id="passkeys-heading"
			title="Passkeys"
			headingRef={heading}
			aside={
				canUsePasskeys &&
				!signInFirst && (
					<LiveButton variant="outline" size="sm" disabled={adding} onClick={add}>
						{adding ? "Adding…" : "Add a passkey"}
					</LiveButton>
				)
			}
		>
			{error && (
				<p role="alert" className={`${CARD_ROW} text-destructive`}>
					{error}
				</p>
			)}
			{failure && (
				<LoadFailure
					message={failure}
					loading={loading}
					onRetry={async () => {
						// The button goes with the failure, and the focus would go with the button.
						if (await reload()) heading.current?.focus();
					}}
				/>
			)}
			{canUsePasskeys && signInFirst && (
				<p className={`${CARD_ROW} text-muted-foreground`}>
					{hasPasskeys ? TWO_FACTORS_TO_ADD_OR_REMOVE : TWO_FACTORS_TO_ADD_A_PASSKEY.message}
				</p>
			)}
			{passkeys === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : passkeys.length === 0 ? (
				<p className={`${CARD_ROW} text-muted-foreground`}>
					Sign in with your fingerprint, your face or your device's PIN, with nothing to type and
					nothing a fake site could ask you for.
				</p>
			) : (
				<ul className="divide-y">
					{passkeys.map((passkey) => (
						<PasskeyRow
							key={passkey.id}
							passkey={passkey}
							mayRemove={signedInWithTwoFactors}
							onChange={changed}
							onRemoved={() => heading.current?.focus()}
							onError={setError}
						/>
					))}
				</ul>
			)}
		</AccountCard>
	);
}

function PasskeyRow({
	passkey,
	mayRemove,
	onChange,
	onRemoved,
	onError,
}: {
	passkey: ListedPasskey;
	/** Whether this session showed two factors. One that did not is told why above the list. */
	mayRemove: boolean;
	onChange: () => Promise<void>;
	/** Its row has gone, and the focus with it. */
	onRemoved: () => void;
	onError: (message: string | null) => void;
}) {
	const [mode, setMode] = useState<"showing" | "renaming" | "removing">("showing");
	const [pending, setPending] = useState(false);
	const name = passkey.name || "Passkey";
	// Each step takes the place of the button that opened it.
	const renameButton = useFocusBack<HTMLButtonElement>(mode === "renaming");
	const removeButton = useFocusBack<HTMLButtonElement>(mode === "removing");

	async function run(
		action: () => Promise<{ error: { message?: string | undefined } | null }>,
		removes = false,
	) {
		setPending(true);
		onError(null);
		try {
			const result = await action();
			if (result.error) {
				onError(passkeyFailure(result.error));
				return;
			}
			await onChange();
			if (removes) onRemoved();
		} catch {
			onError(NOT_DONE);
		} finally {
			setPending(false);
			setMode("showing");
		}
	}

	function rename(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget).get("name"));
		run(() => authClient.passkey.updatePasskey({ id: passkey.id, name: value }));
	}

	if (mode === "renaming") {
		return (
			<li className={CARD_ROW}>
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
						<Button type="submit" size="sm" className={ROW_BUTTON} disabled={pending}>
							{pending ? "Saving…" : "Save"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={ROW_BUTTON}
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
						className={ROW_BUTTON}
						aria-label={`Remove ${name}`}
						disabled={pending}
						onClick={() =>
							run(
								() =>
									authClient.$fetch("/account/remove-passkey", {
										method: "POST",
										body: { id: passkey.id },
									}),
								true,
							)
						}
					>
						{pending ? "Removing…" : "Remove"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className={ROW_BUTTON}
						disabled={pending}
						// The button that was pressed has gone, and this is the one that changes nothing.
						autoFocus
						onClick={() => setMode("showing")}
					>
						Keep
					</Button>
				</div>
			) : (
				<div className="flex shrink-0 gap-2">
					<Button
						ref={renameButton}
						variant="ghost"
						size="sm"
						className={ROW_BUTTON}
						aria-label={`Rename ${name}`}
						onClick={() => setMode("renaming")}
					>
						Rename
					</Button>
					{mayRemove && (
						<Button
							ref={removeButton}
							variant="ghost"
							size="sm"
							className={ROW_BUTTON}
							aria-label={`Remove ${name}`}
							onClick={() => setMode("removing")}
						>
							Remove
						</Button>
					)}
				</div>
			)}
		</li>
	);
}
