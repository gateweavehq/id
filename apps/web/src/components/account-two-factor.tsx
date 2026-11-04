import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { QrCode } from "#/components/qr-code";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

/** What this section is doing, along with what only exists for as long as it is on the screen. */
type Step =
	| { name: "resting" }
	| { name: "asking-password"; action: "turn-on" | "new-codes" | "turn-off" }
	| { name: "confirming"; uri: string; recoveryCodes: string[] }
	| { name: "showing-codes"; recoveryCodes: string[]; turnedOn: boolean };

const WRONG_PASSWORD = "INVALID_PASSWORD";

function messageOf(error: object & { message?: string | undefined }): string {
	if ("code" in error && error.code === WRONG_PASSWORD) return "That password is wrong.";
	return error.message ?? "Something went wrong";
}

const PASSWORD_ACTIONS = {
	"turn-on": { label: "Continue", variant: "default" },
	"new-codes": { label: "Replace my recovery codes", variant: "default" },
	"turn-off": { label: "Turn off", variant: "destructive" },
} as const;

/**
 * Asks for a code from an authenticator app when someone signs in with their password. A passkey has
 * two factors of its own and GitHub has its own sign-in, so neither asks, which is why only someone
 * with a password sees this. See "Two-factor sign-in" in docs/architecture.md.
 */
export function AccountTwoFactor({ enabled, email }: { enabled: boolean; email: string }) {
	const router = useRouter();
	const [step, setStep] = useState<Step>({ name: "resting" });
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	function goTo(next: Step) {
		setStep(next);
		setError(null);
	}

	async function withPassword(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (step.name !== "asking-password") return;
		const password = String(new FormData(event.currentTarget).get("password"));
		setPending(true);
		setError(null);
		switch (step.action) {
			case "turn-on": {
				const result = await authClient.twoFactor.enable({ password });
				setPending(false);
				if (result.error) return setError(messageOf(result.error));
				// For the types: nothing here asks for the other method, and the server refuses it.
				if (result.data.method !== "totp") return setError("Something went wrong");
				return goTo({
					name: "confirming",
					uri: result.data.totpURI,
					recoveryCodes: result.data.backupCodes,
				});
			}
			case "new-codes": {
				const result = await authClient.twoFactor.generateBackupCodes({ password });
				setPending(false);
				if (result.error) return setError(messageOf(result.error));
				return goTo({
					name: "showing-codes",
					recoveryCodes: result.data.backupCodes,
					turnedOn: false,
				});
			}
			case "turn-off": {
				const result = await authClient.twoFactor.disable({ password });
				setPending(false);
				if (result.error) return setError(messageOf(result.error));
				goTo({ name: "resting" });
				return router.invalidate();
			}
		}
	}

	async function confirm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (step.name !== "confirming") return;
		const code = String(new FormData(event.currentTarget).get("code")).trim();
		setPending(true);
		setError(null);
		const result = await authClient.twoFactor.verifyTotp({ code });
		setPending(false);
		if (result.error) {
			return setError(
				"That code is wrong. Check the time on your device, and try the next one if it is about to change.",
			);
		}
		goTo({ name: "showing-codes", recoveryCodes: step.recoveryCodes, turnedOn: true });
		// This replaced the session, and with it what the rest of the page shows.
		await router.invalidate();
	}

	return (
		<section aria-labelledby="two-factor-heading" className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h2 id="two-factor-heading" className="text-sm font-semibold">
					Two-factor sign-in
				</h2>
				{enabled && step.name === "resting" && (
					<span className="text-xs text-muted-foreground">On</span>
				)}
			</div>

			{step.name === "resting" && (
				<Resting
					enabled={enabled}
					onChoose={(action) => goTo({ name: "asking-password", action })}
				/>
			)}

			{step.name === "asking-password" && (
				<form onSubmit={withPassword} className="space-y-4 rounded-lg border p-4">
					{step.action === "turn-off" && (
						<p className="text-sm text-muted-foreground">
							Your password alone will sign you in, and your recovery codes stop working. Apps you
							were signed in to here will ask you to sign in again.
						</p>
					)}
					{step.action === "new-codes" && (
						<p className="text-sm text-muted-foreground">
							Your old recovery codes stop working, and you get ten new ones.
						</p>
					)}
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
						<Label htmlFor="two-factor-password">Your password</Label>
						<Input
							id="two-factor-password"
							name="password"
							type="password"
							autoComplete="current-password"
							autoFocus
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex gap-2">
						<LiveButton
							type="submit"
							size="sm"
							variant={PASSWORD_ACTIONS[step.action].variant}
							disabled={pending}
						>
							{PASSWORD_ACTIONS[step.action].label}
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={pending}
							onClick={() => goTo({ name: "resting" })}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}

			{step.name === "confirming" && (
				<form onSubmit={confirm} className="space-y-4 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">
						Scan this with an authenticator app, such as 1Password, Google Authenticator or Aegis.
					</p>
					<QrCode text={step.uri} label="A QR code for your authenticator app" />
					<SetupKey uri={step.uri} />
					<div className="space-y-2">
						<Label htmlFor="two-factor-code">The code your app shows</Label>
						<Input
							id="two-factor-code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]{6}"
							maxLength={6}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex gap-2">
						<LiveButton type="submit" size="sm" disabled={pending}>
							Turn on
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={pending}
							onClick={() => goTo({ name: "resting" })}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}

			{step.name === "showing-codes" && (
				<RecoveryCodes
					codes={step.recoveryCodes}
					turnedOn={step.turnedOn}
					onDone={async () => {
						goTo({ name: "resting" });
						// The activity below: what this did is written just after the response, so the look
						// taken when the codes appeared can have missed it.
						await router.invalidate();
					}}
				/>
			)}
		</section>
	);
}

function Resting({
	enabled,
	onChoose,
}: {
	enabled: boolean;
	onChoose: (action: "turn-on" | "new-codes" | "turn-off") => void;
}) {
	if (!enabled) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					Ask for a code from an authenticator app whenever you sign in with your password, so that
					your password alone is not enough. A passkey already takes two factors, and GitHub has its
					own sign-in, so neither asks.
				</p>
				<Button variant="outline" size="sm" onClick={() => onChoose("turn-on")}>
					Turn on
				</Button>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">
				Signing in with your password asks for a code from your authenticator app. Passkeys and
				GitHub do not ask.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onClick={() => onChoose("new-codes")}>
					New recovery codes
				</Button>
				<Button variant="ghost" size="sm" onClick={() => onChoose("turn-off")}>
					Turn off
				</Button>
			</div>
		</div>
	);
}

/** For a person who cannot scan, such as someone whose authenticator is on this device. */
function SetupKey({ uri }: { uri: string }) {
	const secret = URL.canParse(uri) ? new URL(uri).searchParams.get("secret") : null;
	if (!secret) return null;
	return (
		<details className="text-sm text-muted-foreground">
			<summary className="cursor-pointer">Can't scan it?</summary>
			<p className="mt-2">Add an account by hand, with this key:</p>
			<code
				data-testid="two-factor-key"
				className="mt-1 block break-all font-mono text-xs text-foreground"
			>
				{secret}
			</code>
		</details>
	);
}

function RecoveryCodes({
	codes,
	turnedOn,
	onDone,
}: {
	codes: string[];
	turnedOn: boolean;
	onDone: () => void;
}) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="space-y-4 rounded-lg border p-4">
			{turnedOn && (
				<p role="status" className="text-sm">
					Two-factor sign-in is on. Apps you were signed in to here will ask you to sign in again.
				</p>
			)}
			<p className="text-sm text-muted-foreground">
				Save these recovery codes somewhere safe. Each one signs you in once if you lose your
				authenticator app, and nobody can show them to you again. Without them or another way to
				sign in, getting back into this account takes whoever runs this service.
			</p>
			<ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
				{codes.map((code) => (
					<li key={code} data-testid="recovery-code" className="break-all">
						{code}
					</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={async () => {
						await navigator.clipboard.writeText(codes.join("\n"));
						setCopied(true);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
				<Button type="button" size="sm" onClick={onDone}>
					I have saved them
				</Button>
			</div>
		</div>
	);
}
