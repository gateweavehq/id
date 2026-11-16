import { describe, expect, it } from "vitest";
import { createSignInLatch } from "./sign-in-latch";

describe("the latch of a page that signs people in", () => {
	it("gives the page to one attempt, and refuses every other until that one has failed", () => {
		const latch = createSignInLatch();
		expect(latch.held).toBe(false);

		const release = latch.take();
		expect(release).not.toBeNull();
		expect(latch.held).toBe(true);
		expect(latch.take()).toBeNull();
		expect(latch.take()).toBeNull();

		release?.();
		expect(latch.held).toBe(false);
		expect(latch.take()).not.toBeNull();
	});

	it("stays taken by an attempt that never gives it back, as one that worked does not", () => {
		const latch = createSignInLatch();
		latch.take();
		expect(latch.take()).toBeNull();
		expect(latch.held).toBe(true);
	});

	it("lets an attempt give the page back once, and not take it from the next", () => {
		const latch = createSignInLatch();
		const first = latch.take();
		first?.();
		const second = latch.take();
		expect(second).not.toBeNull();

		first?.();
		expect(latch.held).toBe(true);
		expect(latch.take()).toBeNull();
	});

	it("is free after a reset, and an attempt from before it cannot free the one after", () => {
		const latch = createSignInLatch();
		const left = latch.take();
		latch.reset();
		expect(latch.held).toBe(false);

		const next = latch.take();
		expect(next).not.toBeNull();
		left?.();
		expect(latch.held).toBe(true);

		next?.();
		expect(latch.held).toBe(false);
	});

	it("tells listeners when it is taken, given back and reset, with the new state already there", () => {
		const latch = createSignInLatch();
		const seen: boolean[] = [];
		const stop = latch.subscribe(() => seen.push(latch.held));

		const release = latch.take();
		expect(seen).toEqual([true]);
		// A refused attempt changes nothing, so nobody hears of it.
		latch.take();
		expect(seen).toEqual([true]);
		release?.();
		expect(seen).toEqual([true, false]);
		// Giving it back a second time changes nothing either.
		release?.();
		expect(seen).toEqual([true, false]);
		latch.take();
		latch.reset();
		expect(seen).toEqual([true, false, true, false]);

		stop();
		latch.take();
		expect(seen).toEqual([true, false, true, false]);
	});

	it("can be taken by a listener that hears it was given back", () => {
		const latch = createSignInLatch();
		let retaken = false;
		latch.subscribe(() => {
			if (!latch.held && !retaken) {
				retaken = true;
				latch.take();
			}
		});

		latch.take()?.();

		expect(latch.held).toBe(true);
	});
});
