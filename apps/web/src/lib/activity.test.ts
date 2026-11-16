import { describe, expect, it } from "vitest";
import { byDay, dayName, foldActivity, ifNotYou, needsALook } from "./activity";
import type { AuditActivity } from "./audit-event";

const MINUTE = 60 * 1000;
/** Noon, so that a few minutes either way stay within one day wherever the test runs. */
const NOON = new Date(2026, 10, 16, 12).getTime();

let made = 0;

function event(type: string, minutesAgo: number, more: Partial<AuditActivity> = {}): AuditActivity {
	return {
		id: `event-${++made}`,
		at: new Date(NOON - minutesAgo * MINUTE).toISOString(),
		type,
		app: null,
		ip: "203.0.113.7",
		device: "Chrome on Windows",
		detail: null,
		...more,
	};
}

/** Newest first, as the server sends them. */
function newestFirst(...events: AuditActivity[]): AuditActivity[] {
	return [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

const typesOf = (events: AuditActivity[]) => events.map(({ type, detail }) => `${type}:${detail}`);

describe("foldActivity", () => {
	it("leaves out the question once the sign-in it led to is there", () => {
		const events = newestFirst(
			event("two_factor_asked", 5, { detail: "password" }),
			event("sign_in", 4, { detail: "totp" }),
		);
		expect(typesOf(foldActivity(events))).toEqual(["sign_in:totp"]);
	});

	it("does the same for a recovery code", () => {
		const events = newestFirst(
			event("two_factor_asked", 5, { detail: "password" }),
			event("sign_in", 4, { detail: "recovery_code" }),
		);
		expect(typesOf(foldActivity(events))).toEqual(["sign_in:recovery_code"]);
	});

	it("keeps a question that no code followed", () => {
		const events = newestFirst(
			event("sign_in", 30, { detail: "passkey" }),
			event("two_factor_asked", 5, { detail: "password" }),
		);
		expect(typesOf(foldActivity(events))).toEqual(["two_factor_asked:password", "sign_in:passkey"]);
	});

	it("keeps a question from somewhere else, however close in time", () => {
		const events = newestFirst(
			event("two_factor_asked", 5, { detail: "password", ip: "198.51.100.9" }),
			event("two_factor_asked", 5, { detail: "password", device: "Firefox on Linux" }),
			event("sign_in", 4, { detail: "totp" }),
		);
		expect(typesOf(foldActivity(events))).toEqual([
			"sign_in:totp",
			"two_factor_asked:password",
			"two_factor_asked:password",
		]);
	});

	it("keeps a question the sign-in came too long after", () => {
		const events = newestFirst(
			event("two_factor_asked", 30, { detail: "password" }),
			event("sign_in", 4, { detail: "totp" }),
		);
		expect(foldActivity(events)).toHaveLength(2);
	});

	it("takes one question for each sign-in, the latest before it", () => {
		const first = event("two_factor_asked", 9, { detail: "password" });
		const second = event("two_factor_asked", 6, { detail: "password" });
		const events = newestFirst(first, second, event("sign_in", 5, { detail: "totp" }));
		// Whoever gave the password the first time went no further.
		expect(foldActivity(events).map(({ id }) => id)).toContain(first.id);
		expect(foldActivity(events).map(({ id }) => id)).not.toContain(second.id);
	});

	it("never takes a question that came after the sign-in", () => {
		const events = newestFirst(
			event("sign_in", 5, { detail: "totp" }),
			event("two_factor_asked", 4, { detail: "password" }),
		);
		expect(foldActivity(events)).toHaveLength(2);
	});

	it("keeps the failed codes in between, and everything else", () => {
		const events = newestFirst(
			event("two_factor_asked", 6, { detail: "password" }),
			event("sign_in_failed", 5, { detail: "totp" }),
			event("sign_in", 4, { detail: "totp" }),
			event("password_changed", 3, { detail: "changed" }),
			event("sign_in", 60, { detail: "password" }),
		);
		expect(typesOf(foldActivity(events))).toEqual([
			"password_changed:changed",
			"sign_in:totp",
			"sign_in_failed:totp",
			"sign_in:password",
		]);
	});

	it("keeps the order it was given, and changes nothing it was given", () => {
		const events = newestFirst(
			event("two_factor_asked", 5, { detail: "password" }),
			event("sign_in", 4, { detail: "totp" }),
			event("account_created", 90),
		);
		const before = structuredClone(events);
		expect(foldActivity(events).map(({ id }) => id)).toEqual([events[0]?.id, events[2]?.id]);
		expect(events).toEqual(before);
	});
});

describe("needsALook", () => {
	it.each(["sign_in_failed", "password_refused", "two_factor_asked"])("marks %s", (type) => {
		expect(needsALook(event(type, 1))).toBe(true);
	});

	it.each(["sign_in", "app_sign_in", "refused", "password_changed", "sessions_revoked"])(
		"leaves %s alone",
		(type) => {
			expect(needsALook(event(type, 1))).toBe(false);
		},
	);

	it("does not mark the question of a sign-in that went through", () => {
		const folded = foldActivity(
			newestFirst(
				event("two_factor_asked", 5, { detail: "password" }),
				event("sign_in", 4, { detail: "totp" }),
			),
		);
		expect(folded.filter(needsALook)).toEqual([]);
	});
});

describe("ifNotYou", () => {
	it("tells someone with a password to change it", () => {
		expect(ifNotYou(true)).toBe("Not you? Change your password and sign out of everything.");
	});

	it("does not send someone with no password to change one", () => {
		expect(ifNotYou(false)).toBe("Not you? Sign out of everything.");
	});
});

describe("byDay", () => {
	it("puts events under the day they happened on, in the order given", () => {
		const today = event("sign_in", 1);
		const alsoToday = event("app_sign_in", 2);
		const yesterday = event("sign_in", 24 * 60);
		const days = byDay([today, alsoToday, yesterday]);
		expect(days.map(({ events }) => events.map(({ id }) => id))).toEqual([
			[today.id, alsoToday.id],
			[yesterday.id],
		]);
		expect(days[0]?.day).toEqual(new Date(2026, 10, 16));
		expect(days[1]?.day).toEqual(new Date(2026, 10, 15));
	});

	it("has nothing for no events", () => {
		expect(byDay([])).toEqual([]);
	});
});

describe("dayName", () => {
	const now = new Date(NOON);

	it("says today and yesterday", () => {
		expect(dayName(new Date(2026, 10, 16), now, "en-US")).toBe("Today");
		expect(dayName(new Date(2026, 10, 15), now, "en-US")).toBe("Yesterday");
	});

	it("says yesterday across the turn of a month", () => {
		expect(dayName(new Date(2026, 9, 31), new Date(2026, 10, 1, 9), "en-US")).toBe("Yesterday");
	});

	it("gives the date before that, with the year once it is another one", () => {
		expect(dayName(new Date(2026, 10, 14), now, "en-US")).toBe("Saturday, November 14");
		expect(dayName(new Date(2025, 11, 31), now, "en-US")).toBe("Wednesday, December 31, 2025");
	});
});
