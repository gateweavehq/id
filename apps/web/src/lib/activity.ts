import type { AuditActivity } from "./audit-event";

// How the account page arranges someone's activity. The log itself stays as it is: every row is
// still there for whoever reads it another way.

/** The ways of signing in that only ever follow the right password. */
const FOLLOWS_A_PASSWORD = new Set(["totp", "recovery_code"]);

/** Long enough for someone to find their phone, and short enough that the two are one sign-in. */
const ONE_SIGN_IN_MS = 10 * 60 * 1000;

function time(event: AuditActivity): number {
	return new Date(event.at).getTime();
}

/**
 * Leaves out "was asked for a code" where the sign-in it led to is on the list too: the two are one
 * sign-in, and two rows for it bury what matters. One that nothing followed stays, because a right
 * password with no code after it is the row someone most needs to see.
 *
 * A sign-in takes one question before it, from the same kind of device, within ten minutes. The
 * address may differ: a phone leaves the wifi between the password and the code, and a code that was
 * right closes the question whatever network it crossed. Where several questions are open, it takes
 * the latest from its own address, and only without one the latest from another, so that the one left
 * showing is the one from somewhere else. Takes and returns events newest first, as the server sends
 * them.
 */
export function foldActivity(events: AuditActivity[]): AuditActivity[] {
	const folded = new Set<string>();
	const unanswered: AuditActivity[] = [];
	for (const event of [...events].reverse()) {
		if (event.type === "two_factor_asked") {
			unanswered.push(event);
			continue;
		}
		if (event.type !== "sign_in" || !FOLLOWS_A_PASSWORD.has(event.detail ?? "")) continue;
		const led = (question: AuditActivity) =>
			question.device === event.device && time(event) - time(question) <= ONE_SIGN_IN_MS;
		const fromHere = unanswered.findLastIndex(
			(question) => led(question) && question.ip === event.ip,
		);
		const asked = fromHere >= 0 ? fromHere : unanswered.findLastIndex(led);
		const [question] = asked >= 0 ? unanswered.splice(asked, 1) : [];
		if (question) folded.add(question.id);
	}
	return events.filter((event) => !folded.has(event.id));
}

/**
 * How much an event should stop someone, for what is left after `foldActivity`.
 *
 * - `alarm`: a right password that no code followed. Someone knows the password. It is the only one
 *   in red, since marking everything alike teaches people to pass over the one that matters.
 * - `notice`: a sign-in that failed, or a wrong password on the account page. Usually their own
 *   slip, and worth a look only if it keeps happening.
 */
export type Concern = "alarm" | "notice";

export function concernOf(event: AuditActivity): Concern | undefined {
	if (event.type === "two_factor_asked") return "alarm";
	if (event.type === "sign_in_failed" || event.type === "password_refused") return "notice";
	return undefined;
}

/** What to do if it was not them. An account with no password has none to change. */
export function ifNotYou(concern: Concern, hasPassword: boolean): string {
	if (concern === "alarm") {
		return hasPassword
			? "Not you? Change your password now and sign out of everything."
			: "Not you? Sign out of everything.";
	}
	return hasPassword
		? "Not you? If this keeps happening, change your password."
		: "Not you? If this keeps happening, sign out of everything.";
}

export interface ActivityDay {
	/** Midnight of that day, where the person is. */
	day: Date;
	events: AuditActivity[];
}

function startOfDay(moment: Date): Date {
	return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

/** Events under the day they happened on, in the person's own time zone. Keeps their order. */
export function byDay(events: AuditActivity[]): ActivityDay[] {
	const days: ActivityDay[] = [];
	for (const event of events) {
		const day = startOfDay(new Date(event.at));
		const last = days.at(-1);
		if (last && last.day.getTime() === day.getTime()) last.events.push(event);
		else days.push({ day, events: [event] });
	}
	return days;
}

/** "Today", "Yesterday", or the date, with its year once that is not this one. */
export function dayName(day: Date, now: Date, locale?: string): string {
	const today = startOfDay(now);
	if (day.getTime() === today.getTime()) return "Today";
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	if (day.getTime() === yesterday.getTime()) return "Yesterday";
	return day.toLocaleDateString(locale, {
		weekday: "long",
		month: "long",
		day: "numeric",
		...(day.getFullYear() !== today.getFullYear() && { year: "numeric" }),
	});
}
