import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSignInLatch,
	GIVE_BACK_AFTER,
	type ShownPage,
	STILL_HERE_AFTER,
	takeWhenReady,
} from "./sign-in-latch";

/** A page someone is looking at, which counts how often the browser was stopped. */
function shownPage(visible = true) {
	const page: ShownPage & { isVisible: boolean; stopped: number } = {
		isVisible: visible,
		stopped: 0,
		visible: () => page.isVisible,
		stop: () => {
			page.stopped++;
		},
	};
	return page;
}

describe("the latch of a page that signs people in", () => {
	it("gives the page to one attempt, and refuses every other until that one has failed", () => {
		const latch = createSignInLatch(shownPage());
		expect(latch.held).toBe(false);
		expect(latch.phase).toBe("free");

		const attempt = latch.take();
		expect(attempt).not.toBeNull();
		expect(latch.held).toBe(true);
		expect(latch.phase).toBe("taken");
		expect(latch.take()).toBeNull();
		expect(latch.take()).toBeNull();

		attempt?.release();
		expect(latch.held).toBe(false);
		expect(latch.phase).toBe("free");
		expect(latch.take()).not.toBeNull();
	});

	it("lets an attempt give the page back once, and not take it from the next", () => {
		const latch = createSignInLatch(shownPage());
		const first = latch.take();
		first?.release();
		const second = latch.take();
		expect(second).not.toBeNull();

		first?.release();
		expect(latch.held).toBe(true);
		expect(latch.take()).toBeNull();
	});

	it("is free after a reset, and an attempt from before it cannot free the one after", () => {
		const latch = createSignInLatch(shownPage());
		const left = latch.take();
		left?.leave();
		latch.reset();
		expect(latch.held).toBe(false);
		expect(latch.phase).toBe("free");

		const next = latch.take();
		expect(next).not.toBeNull();
		left?.release();
		left?.leave();
		expect(latch.held).toBe(true);
		expect(latch.phase).toBe("taken");

		next?.release();
		expect(latch.held).toBe(false);
	});

	it("tells listeners when it is taken, given back and reset, with the new state already there", () => {
		const latch = createSignInLatch(shownPage());
		const seen: boolean[] = [];
		const stop = latch.subscribe(() => seen.push(latch.held));

		const attempt = latch.take();
		expect(seen).toEqual([true]);
		// A refused attempt changes nothing, so nobody hears of it.
		latch.take();
		expect(seen).toEqual([true]);
		attempt?.release();
		expect(seen).toEqual([true, false]);
		// Giving it back a second time changes nothing either.
		attempt?.release();
		expect(seen).toEqual([true, false]);
		latch.take();
		latch.reset();
		expect(seen).toEqual([true, false, true, false]);

		stop();
		latch.take();
		expect(seen).toEqual([true, false, true, false]);
	});

	it("can be taken by a listener that hears it was given back", () => {
		const latch = createSignInLatch(shownPage());
		let retaken = false;
		latch.subscribe(() => {
			if (!latch.held && !retaken) {
				retaken = true;
				latch.take();
			}
		});

		latch.take()?.release();

		expect(latch.held).toBe(true);
	});
});

describe("an attempt that worked, on a page that is leaving", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the page, says it is leaving, and after a while that it is still here", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		const phases: string[] = [];
		latch.subscribe(() => phases.push(latch.phase));

		latch.take()?.leave();
		expect(latch.phase).toBe("leaving");
		expect(latch.take()).toBeNull();

		await vi.advanceTimersByTimeAsync(STILL_HERE_AFTER - 1);
		expect(latch.phase).toBe("leaving");
		await vi.advanceTimersByTimeAsync(1);
		expect(latch.phase).toBe("still-here");
		expect(phases).toEqual(["taken", "leaving", "still-here"]);

		// With someone signed in, and so a code that may have reached the app, it is never given back.
		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 10);
		expect(latch.held).toBe(true);
		expect(latch.take()).toBeNull();
		expect(page.stopped).toBe(0);
	});

	it("gives the page back when nothing came of the attempt, having stopped the browser first", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		const asked: number[] = [];
		latch.take()?.leave(async () => {
			asked.push(page.stopped);
			return true;
		});

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER - 1);
		expect(latch.held).toBe(true);
		expect(asked).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(latch.held).toBe(false);
		expect(latch.phase).toBe("free");
		// Once before the browser was stopped and once after, which is the answer that counts.
		expect(asked).toEqual([0, 1]);
		expect(page.stopped).toBe(1);
	});

	it("keeps the page, and leaves the browser alone, when someone has been signed in meanwhile", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		latch.take()?.leave(async () => false);

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 3);

		expect(latch.held).toBe(true);
		expect(latch.phase).toBe("still-here");
		// One on its way to an app with a code is left to arrive.
		expect(page.stopped).toBe(0);
	});

	it("keeps the page when someone was signed in between asking and stopping", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		latch.take()?.leave(async () => page.stopped === 0);

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 3);

		expect(page.stopped).toBe(1);
		expect(latch.held).toBe(true);
	});

	it("keeps the page when it cannot find out", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		latch.take()?.leave(async () => {
			throw new Error("no network");
		});

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 3);

		expect(latch.held).toBe(true);
		expect(page.stopped).toBe(0);
	});

	it("waits for someone to be looking at the page before it asks", async () => {
		const page = shownPage(false);
		const latch = createSignInLatch(page);
		let asked = 0;
		latch.take()?.leave(async () => {
			asked++;
			return true;
		});

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 2);
		expect(asked).toBe(0);
		expect(latch.held).toBe(true);

		page.isVisible = true;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(latch.held).toBe(false);
	});

	it("does nothing more by itself once the page is going", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		let asked = 0;
		latch.take()?.leave(async () => {
			asked++;
			return true;
		});

		latch.halt();
		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 3);

		expect(asked).toBe(0);
		expect(page.stopped).toBe(0);
		expect(latch.phase).toBe("leaving");
	});

	it("does not stop the browser for a page that started going while it was asking", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		let answer: (nothing: boolean) => void = () => {};
		latch.take()?.leave(() => new Promise<boolean>((resolve) => (answer = resolve)));
		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER);

		latch.halt();
		answer(true);
		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER);

		expect(page.stopped).toBe(0);
		expect(latch.held).toBe(true);
	});

	it("does not give back the page of a later attempt", async () => {
		const page = shownPage();
		const latch = createSignInLatch(page);
		latch.take()?.leave(async () => true);
		latch.reset();
		const next = latch.take();

		await vi.advanceTimersByTimeAsync(GIVE_BACK_AFTER * 3);

		expect(next).not.toBeNull();
		expect(latch.held).toBe(true);
		expect(latch.phase).toBe("taken");
		expect(page.stopped).toBe(0);
	});
});

describe("an attempt with something to wait for before its request is sent", () => {
	it("leaves the page free while it waits, and takes it when that is done", async () => {
		const latch = createSignInLatch(shownPage());
		let done: (value: string) => void = () => {};
		const taking = takeWhenReady(latch, () => new Promise<string>((resolve) => (done = resolve)));

		expect(latch.held).toBe(false);
		done("checked");

		const taken = await taking;
		expect(taken?.value).toBe("checked");
		expect(latch.held).toBe(true);
		taken?.attempt.release();
		expect(latch.held).toBe(false);
	});

	it("is dropped when another way of signing in started while it waited", async () => {
		const latch = createSignInLatch(shownPage());
		let done: () => void = () => {};
		const taking = takeWhenReady(latch, () => new Promise<void>((resolve) => (done = resolve)));

		const other = latch.take();
		expect(other).not.toBeNull();
		done();

		expect(await taking).toBeNull();
		// The other one still has the page, and is the only one that can give it back.
		expect(latch.held).toBe(true);
		other?.release();
		expect(latch.held).toBe(false);
	});

	it("is dropped even when the other way has failed by the time it is ready", async () => {
		const latch = createSignInLatch(shownPage());
		let done: () => void = () => {};
		const taking = takeWhenReady(latch, () => new Promise<void>((resolve) => (done = resolve)));

		latch.take()?.release();
		done();

		expect(await taking).toBeNull();
		expect(latch.held).toBe(false);
	});

	it("never takes the page when what it waits for never comes", async () => {
		const latch = createSignInLatch(shownPage());
		void takeWhenReady(latch, () => new Promise<void>(() => {}));
		await Promise.resolve();

		expect(latch.held).toBe(false);
		expect(latch.take()).not.toBeNull();
	});

	it("leaves the page free when what it waits for fails", async () => {
		const latch = createSignInLatch(shownPage());

		await expect(
			takeWhenReady(latch, async () => {
				throw new Error("no check");
			}),
		).rejects.toThrow("no check");
		expect(latch.held).toBe(false);
	});

	it("does not start waiting when the page is taken", async () => {
		const latch = createSignInLatch(shownPage());
		latch.take();
		let waited = false;

		const taken = await takeWhenReady(latch, async () => {
			waited = true;
		});

		expect(taken).toBeNull();
		expect(waited).toBe(false);
	});
});
