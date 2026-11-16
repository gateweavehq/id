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
 * A sign-in takes the latest question before it, from the same place, within ten minutes. Takes and
 * returns events newest first, as the server sends them.
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
		const asked = unanswered.findLastIndex(
			(question) =>
				question.ip === event.ip &&
				question.device === event.device &&
				time(event) - time(question) <= ONE_SIGN_IN_MS,
		);
		const [question] = asked >= 0 ? unanswered.splice(asked, 1) : [];
		if (question) folded.add(question.id);
	}
	return events.filter((event) => !folded.has(event.id));
}

/**
 * Whether an event is one to stop at: someone tried to get in and did not, or had the password and
 * went no further. Meant for what is left after `foldActivity`, where a question still on the list
 * is one that no code followed.
 */
export function needsALook(event: AuditActivity): boolean {
	return (
		event.type === "sign_in_failed" ||
		event.type === "password_refused" ||
		event.type === "two_factor_asked"
	);
}

/** What to do about an event that was not them. An account with no password has none to change. */
export function ifNotYou(hasPassword: boolean): string {
	return hasPassword
		? "Not you? Change your password and sign out of everything."
		: "Not you? Sign out of everything.";
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
