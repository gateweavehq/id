import { browserSupportsWebAuthn, WebAuthnAbortService } from "@simplewebauthn/browser";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { onItsWay, type Search } from "#/lib/oauth-flow";
import { nothingHappened, passkeyFailure } from "#/lib/passkey-errors";

/**
 * "Use a passkey", and the browser offering one under the email field of the form on the same page,
 * which needs `webauthn` in that field's `autocomplete`. Starting one of these cancels the other,
 * since a browser runs one at a time.
 */
export function PasskeySignIn({ next, search }: { next: string; search: Search }) {
	const router = useRouter();
	const hydrated = useHydrated();
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);

	/** Whether it signed them in. */
	const signIn = useCallback(
		async (autoFill: boolean): Promise<boolean> => {
			const result = await authClient.signIn.passkey({ autoFill });
			if (result.error) {
				if (!nothingHappened(result.error)) {
					setError(
						failureMessage({ ...result.error, message: passkeyFailure(result.error) }, search),
					);
				}
				return false;
			}
			if (onItsWay(result.data)) return true;
			await router.invalidate();
			await router.navigate({ href: next });
			return true;
		},
		[next, router, search],
	);

	const offerInField = useCallback(async () => {
		if (await PublicKeyCredential.isConditionalMediationAvailable?.()) await signIn(true);
	}, [signIn]);

	useEffect(() => {
		if (!browserSupportsWebAuthn()) return;
		offerInField();
		// It would otherwise keep waiting on the next page, for a field that is no longer there.
		return () => WebAuthnAbortService.cancelCeremony();
	}, [offerInField]);

	// On the server nobody knows yet, and the button arrives disabled regardless.
	if (hydrated && !browserSupportsWebAuthn()) return null;

	async function onClick() {
		setPending(true);
		setError(null);
		const signedIn = await signIn(false);
		// Going back from an app can bring this page back as it was, so it must not stay disabled.
		setPending(false);
		// They may still want it after closing the browser's window.
		if (!signedIn) offerInField();
	}

	return (
		<>
			<LiveButton variant="outline" className="w-full" disabled={pending} onClick={onClick}>
				Use a passkey
			</LiveButton>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</>
	);
}
