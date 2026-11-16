import { browserSupportsWebAuthn, WebAuthnAbortService } from "@simplewebauthn/browser";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { onItsWay, type Search } from "#/lib/oauth-flow";
import { nothingHappened, passkeyFailure } from "#/lib/passkey-errors";
import { type Release, type SignInLatch, useSignInBusy } from "#/lib/sign-in-latch";

/**
 * "Use a passkey", and the browser offering one under the email field of the form on the same page,
 * which needs `webauthn` in that field's `autocomplete`. Starting one of these cancels the other,
 * since a browser runs one at a time.
 *
 * The offer waits for as long as the page shows, which on the way to an app is until the app has
 * answered, so it can be answered after another way of signing in has already sent the browser off.
 * It therefore ends when anything takes the page's latch, and comes back when that attempt has failed.
 */
export function PasskeySignIn({
	next,
	search,
	latch,
}: {
	next: string;
	search: Search;
	latch: SignInLatch;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	const [error, setError] = useState<ReactNode>(null);
	const busy = useSignInBusy(latch);

	/** `held` is the latch as the button took it. The offer in the field has none until it is answered. */
	const signIn = useCallback(
		async (autoFill: boolean, held: Release | null) => {
			let release = held;
			const result = await authClient.signIn.passkey({
				autoFill,
				fetchOptions: {
					// This runs before the answer is sent to be checked, which is the request that signs
					// someone in, and throwing here means it is never sent. Ending the ceremony is not
					// enough by itself: it does nothing to one whose options are still on their way, which
					// starts when they arrive, nor to one the authenticator has already answered.
					onRequest: () => {
						if (release) return;
						release = latch.take();
						if (!release) throw new Error("Another sign-in has started on this page");
					},
				},
			});
			if (result.error) {
				if (!nothingHappened(result.error)) {
					setError(
						failureMessage({ ...result.error, message: passkeyFailure(result.error) }, search),
					);
				}
				release?.();
				return;
			}
			// From here the browser is leaving, and the latch stays taken until it has.
			if (onItsWay(result.data)) return;
			await router.invalidate();
			await router.navigate({ href: next });
		},
		[latch, next, router, search],
	);

	const offerInField = useCallback(async () => {
		if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
		if (!latch.held) await signIn(true, null);
	}, [latch, signIn]);

	useEffect(() => {
		if (!browserSupportsWebAuthn()) return;
		// The latch tells this the moment it changes, so the offer has ended before the attempt that
		// took it sends anything. Given back, they may still want a passkey: after a wrong password,
		// or after closing the browser's window.
		const offerWhileFree = () => {
			if (latch.held) WebAuthnAbortService.cancelCeremony();
			else offerInField();
		};
		offerWhileFree();
		const stop = latch.subscribe(offerWhileFree);
		return () => {
			stop();
			// It would otherwise keep waiting on the next page, for a field that is no longer there.
			WebAuthnAbortService.cancelCeremony();
		};
	}, [latch, offerInField]);

	// On the server nobody knows yet, and the button arrives disabled regardless.
	if (hydrated && !browserSupportsWebAuthn()) return null;

	async function onClick() {
		const release = latch.take();
		if (!release) return;
		setError(null);
		await signIn(false, release);
	}

	return (
		<>
			<LiveButton variant="outline" className="w-full" disabled={busy} onClick={onClick}>
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
