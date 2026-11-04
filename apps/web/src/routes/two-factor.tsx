import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, type Search } from "#/lib/oauth-flow";
import { safeRedirect } from "#/lib/redirect";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Loose, because on the way to an app the query is the app's signed request. See `lib/oauth-flow`.
const twoFactorSearch = z.looseObject({
	/** Where to go once signed in. */
	redirect: z.string().optional().catch(undefined),
});

/** The second step of signing in with a password. The password's page sends people here. */
export const Route = createFileRoute("/two-factor")({
	validateSearch: twoFactorSearch,
	beforeLoad: async ({ search }) => {
		if (inFlow(search)) return;
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/account" });
	},
	component: TwoFactorPage,
});

function codeOf(error: object): string | undefined {
	return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** What to tell someone whose code did not get them in. */
function refusal(
	error: object & { message?: string | undefined },
	search: Search & { redirect?: string | undefined },
): ReactNode {
	switch (codeOf(error)) {
		case "INVALID_CODE":
			return "That code is wrong. Check your authenticator app, and try the next one if it is about to change.";
		case "INVALID_BACKUP_CODE":
			return "That recovery code is wrong, or has already been used.";
		case "ACCOUNT_TEMPORARILY_LOCKED":
			return "Too many wrong codes. Wait 15 minutes, then try again.";
		// The password was right a while ago, or there have been too many tries since.
		case "INVALID_TWO_FACTOR_COOKIE":
		case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
			return (
				<>
					This sign-in has run out.{" "}
					<Link
						to="/login"
						search={{ redirect: search.redirect, ...flowSearch(search) }}
						className="font-medium underline underline-offset-4"
					>
						Sign in again
					</Link>
				</>
			);
		default:
			return failureMessage(error, search);
	}
}

function TwoFactorPage() {
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/account";
	const router = useRouter();
	const [recovery, setRecovery] = useState(false);
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	useDocumentTitle("Enter your code");

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const element = event.currentTarget;
		const code = String(new FormData(element).get("code")).trim();
		setPending(true);
		setError(null);
		const result = recovery
			? await authClient.twoFactor.verifyBackupCode({ code: code.toLowerCase() })
			: await authClient.twoFactor.verifyTotp({ code });
		setPending(false);
		if (result.error) {
			setError(refusal(result.error, search));
			element.reset();
			return;
		}
		// The auth client has already sent the browser on, when this is on the way to an app.
		if (onItsWay(result.data)) return;
		await router.invalidate();
		await router.navigate({ href: next });
	}

	function switchTo(usingRecovery: boolean) {
		setRecovery(usingRecovery);
		setError(null);
	}

	return (
		<AuthPage
			title={recovery ? "Enter a recovery code" : "Enter your code"}
			description={
				recovery
					? "One of the codes you saved when you turned this on. Each works once."
					: "Open your authenticator app and enter the code it shows for Gateweave ID."
			}
		>
			{/* A new key, so that one kind of code does not stay in the field for the other. */}
			<form key={recovery ? "recovery" : "totp"} onSubmit={onSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="code">{recovery ? "Recovery code" : "Code"}</Label>
					{recovery ? (
						<Input id="code" name="code" autoComplete="off" spellCheck={false} autoFocus required />
					) : (
						<Input
							id="code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]{6}"
							maxLength={6}
							autoFocus
							required
						/>
					)}
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" className="w-full" disabled={pending}>
					Continue
				</LiveButton>
			</form>
			<Button
				type="button"
				variant="link"
				size="sm"
				className="w-full"
				onClick={() => switchTo(!recovery)}
			>
				{recovery ? "Use your authenticator app" : "I can't use my authenticator app"}
			</Button>
		</AuthPage>
	);
}
