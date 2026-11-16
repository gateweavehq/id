import { useEffect, useState, useSyncExternalStore } from "react";

// A page that signs people in offers several ways at once, and each of them ends by sending the
// browser somewhere. Two that finish together both do: on the way to an app, the provider answers each
// with a code for the same request, the second navigation cancels the first after the app has used up
// its one-time state, and the person lands on the app's error page. So a page lets one attempt run at a
// time. Whoever starts one takes the latch, and gives it back only when the attempt has failed. One
// that worked keeps it, because the browser is leaving and the page must stay out of the way until it
// has gone.

/** Gives the page back, for an attempt that failed. Once, and only while it is still that attempt's. */
export type Release = () => void;

export type SignInLatch = {
	/** Whether an attempt has the page. */
	readonly held: boolean;
	/** Takes the page for one attempt. Null when another has it, and then the caller starts nothing. */
	take(): Release | null;
	/** Frees the page whoever had it, for one that the browser brought back as it was left. */
	reset(): void;
	/** Tells the listener, at once, every time the page is taken or given back. */
	subscribe(listener: () => void): () => void;
};

export function createSignInLatch(): SignInLatch {
	let holder: symbol | null = null;
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of [...listeners]) listener();
	};
	return {
		get held() {
			return holder !== null;
		},
		take() {
			if (holder) return null;
			const attempt = Symbol("sign-in");
			holder = attempt;
			changed();
			return () => {
				// An attempt from before a reset must not free the page under the one that came after.
				if (holder !== attempt) return;
				holder = null;
				changed();
			};
		},
		reset() {
			holder = null;
			changed();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/**
 * The latch of one page, shared by every way of signing in on it. Going back from an app or from
 * GitHub can bring the page back exactly as it was left (`pageshow` with `persisted`), with the latch
 * still taken by the attempt that left, so that frees it. A page loaded again starts with a new one.
 */
export function useSignInLatch(): SignInLatch {
	const [latch] = useState(createSignInLatch);
	useEffect(() => {
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.persisted) latch.reset();
		};
		window.addEventListener("pageshow", onPageShow);
		return () => window.removeEventListener("pageshow", onPageShow);
	}, [latch]);
	return latch;
}

/** Whether an attempt has the page, for disabling what would start another. */
export function useSignInBusy(latch: SignInLatch): boolean {
	return useSyncExternalStore(
		latch.subscribe,
		() => latch.held,
		() => false,
	);
}
