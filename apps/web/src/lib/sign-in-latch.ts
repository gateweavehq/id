import { useEffect, useState, useSyncExternalStore } from "react";

// A page that signs people in offers several ways at once, and each of them ends by sending the
// browser somewhere. Two that finish together both do: on the way to an app, the provider answers each
// with a code for the same request, the second navigation cancels the first after the app has used up
// its one-time state, and the person lands on the app's error page. So a page lets one attempt run at a
// time. Whoever starts one takes the latch, and gives it back when the attempt has failed. One that
// worked says the browser is leaving, and keeps it: the page must stay out of the way until it has gone.
//
// A browser does not say when someone stops it on the way, so a page that is still showing after a
// while says so and offers to load again. It gives the latch back by itself only where it can find out
// that nothing came of the attempt, since otherwise a second one would be the very thing this prevents.

/** How long a page that is leaving waits before it says it is still here. */
export const STILL_HERE_AFTER = 5_000;

/**
 * How long a page that is leaving waits before it asks whether anything came of the attempt. Leaving
 * takes about two seconds when it works, so by now someone has been looking at dead buttons for a
 * while. Being right does not depend on the number: see `leave`.
 */
export const GIVE_BACK_AFTER = 15_000;

/** One way of signing in that has the page. */
export type Attempt = {
	/** It failed: gives the page back. Once, and only while the page is still this attempt's. */
	release(): void;
	/**
	 * It worked, and the browser is leaving. The page stays taken, and says so.
	 *
	 * `cameToNothing` is for a way that hands the browser to someone else before anyone is signed in,
	 * and answers whether still nobody is. If the page is still showing after `GIVE_BACK_AFTER`, it is
	 * asked, and only if nothing has come of the attempt is the browser stopped from going on with it,
	 * and asked again. A second yes gives the page back: whatever the attempt was waiting for can no
	 * longer arrive, and had not arrived when it was stopped, so no app has heard of it. Anything else
	 * keeps the page taken, as does a way that leaves with someone already signed in, and so with a
	 * code that may have reached the app.
	 */
	leave(cameToNothing?: () => Promise<boolean>): void;
};

/** `still-here` is `leaving` that has gone on for longer than leaving takes. */
export type Phase = "free" | "taken" | "leaving" | "still-here";

export type SignInLatch = {
	/** Whether an attempt has the page. */
	readonly held: boolean;
	readonly phase: Phase;
	/** Takes the page for one attempt. Null when another has it, and then the caller starts nothing. */
	take(): Attempt | null;
	/** Frees the page whoever had it, for one that the browser brought back as it was left. */
	reset(): void;
	/** The page is going, or gone: nothing more happens by itself. */
	halt(): void;
	/** Tells the listener, at once, every time the page is taken, given back or changes phase. */
	subscribe(listener: () => void): () => void;
};

/** What the latch needs of the page it is on, which a test stands in for. */
export type ShownPage = {
	/** Whether someone can see it. A page in a background tab is not one anybody is waiting at. */
	visible(): boolean;
	/** Stops the browser from going where it was going, as its Stop button does. */
	stop(): void;
};

const thisPage: ShownPage = {
	visible: () => document.visibilityState === "visible",
	stop: () => window.stop(),
};

export function createSignInLatch(page: ShownPage = thisPage): SignInLatch {
	let holder: symbol | null = null;
	let phase: Phase = "free";
	let timers: ReturnType<typeof setTimeout>[] = [];
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of [...listeners]) listener();
	};
	/** Goes up when the page is going, so that what was already asking does not act on the answer. */
	let halts = 0;
	const halt = () => {
		halts++;
		for (const timer of timers) clearTimeout(timer);
		timers = [];
	};
	const free = () => {
		halt();
		holder = null;
		phase = "free";
		changed();
	};
	return {
		get held() {
			return holder !== null;
		},
		get phase() {
			return phase;
		},
		take() {
			if (holder) return null;
			const attempt = Symbol("sign-in");
			holder = attempt;
			phase = "taken";
			changed();
			// An attempt from before a reset must not free the page under the one that came after.
			const mine = () => holder === attempt;

			const giveBack = async (cameToNothing: () => Promise<boolean>) => {
				if (!mine()) return;
				if (!page.visible()) {
					timers.push(setTimeout(() => giveBack(cameToNothing), 1_000));
					return;
				}
				// A page that started going while this was asking is somebody else's to stop by now.
				const began = halts;
				const still = () => mine() && halts === began;
				try {
					// Asked before stopping, so that one on its way to an app is left to arrive.
					if (!(await cameToNothing()) || !still()) return;
					page.stop();
					if (!(await cameToNothing()) || !still()) return;
				} catch {
					return;
				}
				free();
			};

			return {
				release() {
					if (mine()) free();
				},
				leave(cameToNothing) {
					if (!mine() || phase !== "taken") return;
					phase = "leaving";
					changed();
					timers.push(
						setTimeout(() => {
							if (!mine()) return;
							phase = "still-here";
							changed();
						}, STILL_HERE_AFTER),
					);
					if (cameToNothing) {
						timers.push(setTimeout(() => giveBack(cameToNothing), GIVE_BACK_AFTER));
					}
				},
			};
		},
		reset: free,
		halt,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/**
 * Takes the page for an attempt that has something to wait for before its request can be sent, such as
 * the check that a person is there. The page is taken only once that is done: the check can ask
 * someone to click, or never answer, and the other ways of signing in have to work meanwhile. One of
 * them started in that time drops this attempt, even if it has failed since: whoever pressed another
 * button is no longer waiting for this one. Null then, and when the page was taken to begin with.
 */
export async function takeWhenReady<T>(
	latch: SignInLatch,
	ready: () => Promise<T>,
): Promise<{ attempt: Attempt; value: T } | null> {
	if (latch.held) return null;
	let overtaken = false;
	const stop = latch.subscribe(() => {
		if (latch.held) overtaken = true;
	});
	let value: T;
	try {
		value = await ready();
	} finally {
		stop();
	}
	if (overtaken) return null;
	const attempt = latch.take();
	return attempt ? { attempt, value } : null;
}

/**
 * The latch of one page, shared by every way of signing in on it. Going back from an app or from
 * GitHub can bring the page back exactly as it was left (`pageshow` with `persisted`), with the latch
 * still taken by the attempt that left, so that frees it. A page loaded again starts with a new one.
 */
export function useSignInLatch(): SignInLatch {
	const [latch] = useState(() => createSignInLatch());
	useEffect(() => {
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.persisted) latch.reset();
		};
		window.addEventListener("pageshow", onPageShow);
		// A page the browser has put away must not act on a timer when it comes back, before it is told.
		window.addEventListener("pagehide", latch.halt);
		return () => {
			window.removeEventListener("pageshow", onPageShow);
			window.removeEventListener("pagehide", latch.halt);
			latch.halt();
		};
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

/** How far the attempt that has the page has come, for saying so. */
export function useSignInPhase(latch: SignInLatch): Phase {
	return useSyncExternalStore(
		latch.subscribe,
		() => latch.phase,
		() => "free" as const,
	);
}
