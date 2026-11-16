import { browserSupportsWebAuthn, WebAuthnAbortService } from "@simplewebauthn/browser";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { onItsWay, type Search } from "#/lib/oauth-flow";
import { nothingHappened, passkeyFailure } from "#/lib/passkey-errors";
import { type Attempt, type SignInLatch, useSignInBusy } from "#/lib/sign-in-latch";

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
		async (autoFill: boolean, held: Attempt | null) => {
			let attempt = held;
			let result: Awaited<ReturnType<typeof authClient.signIn.passkey>>;
			try {
				result = await authClient.signIn.passkey({
					autoFill,
					fetchOptions: {
						// This runs before the answer is sent to be checked, which is the request that
						// signs someone in, and throwing here means it is never sent. Ending the ceremony
						// is not enough by itself: it does nothing to one whose options are still on
						// their way, which starts when they arrive, nor to one the authenticator has
						// already answered.
						onRequest: () => {
							if (attempt) return;
							attempt = latch.take();
							if (!attempt) throw new Error("Another sign-in has started on this page");
						},
					},
				});
			} catch {
				// The client catches what the ceremony and the check throw, and not its request for
				// the options, which fails this way with no network. Kept, the latch would leave the
				// page with nothing to press. What the browser says about that is not for people, and
				// the offer in the field asked for nothing, so it says nothing at all.
				if (held) setError("Something went wrong");
				attempt?.release();
				return;
			}
			if (result.error) {
				if (!nothingHappened(result.error)) {
					setError(
						failureMessage({ ...result.error, message: passkeyFailure(result.error) }, search),
					);
				}
				attempt?.release();
				return;
			}
			// From here the browser is leaving, and the latch stays taken until it has.
			attempt?.leave();
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
		// Only when it is taken or given back: it also tells how far the attempt that has it has come,
		// and ending "the ceremony" then would end the passkey button's own.
		let held: boolean | undefined;
		const offerWhileFree = () => {
			if (held === latch.held) return;
			held = latch.held;
			if (held) WebAuthnAbortService.cancelCeremony();
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
		const attempt = latch.take();
		if (!attempt) return;
		setError(null);
		await signIn(false, attempt);
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
