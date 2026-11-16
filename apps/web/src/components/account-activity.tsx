import { type Ref, useEffect, useRef, useState } from "react";
import {
	AccountCard,
	CARD_ROW,
	LoadFailure,
	ROW_BUTTON,
	useLoaded,
} from "#/components/account-section";
import { Button } from "#/components/ui/button";
import { byDay, concernOf, dayName, foldActivity, ifNotYou } from "#/lib/activity";
import { type AuditActivity, describeActivity } from "#/lib/audit-event";
import { authClient } from "#/lib/auth-client";
import { cn } from "#/lib/utils";

const NOT_LOADED = "Your activity could not be loaded";

/** How many rows there are to begin with, and how many more each press brings. */
const PAGE = 10;
/** As many as the server sends: past this, there may be more that the page cannot show. */
const MOST = 50;

const listActivity = () => authClient.$fetch<{ events: AuditActivity[] }>("/account/activity");

/**
 * What has happened to this account lately, so someone can spot what was not them. It loads in the
 * browser, as their sessions do: dates read in their own time zone and language.
 *
 * The latest ten, under the day they happened on, with the rest a press away, so that the one row
 * that matters is not the fortieth of fifty alike.
 */
export function AccountActivity({ hasPassword }: { hasPassword: boolean }) {
	const { data, failure, loading, reload } = useLoaded(listActivity, NOT_LOADED);
	const [shown, setShown] = useState(PAGE);
	const heading = useRef<HTMLHeadingElement>(null);
	const firstOfMore = useRef<HTMLLIElement>(null);
	const events = data ? foldActivity(data.events) : null;
	const now = new Date();

	// The button moves down, or goes, so the focus goes to the first of what it brought.
	useEffect(() => {
		if (shown > PAGE) firstOfMore.current?.focus();
	}, [shown]);

	return (
		<AccountCard id="activity-heading" title="Recent activity" headingRef={heading}>
			{failure && (
				<LoadFailure
					message={failure}
					loading={loading}
					onRetry={async () => {
						// The button goes with the failure, and the focus would go with the button.
						if (await reload()) heading.current?.focus();
					}}
				/>
			)}
			{events === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : (
				<>
					{byDay(events.slice(0, shown)).map(({ day, events: thatDay }) => (
						<div key={day.getTime()}>
							<h4 className="px-4 pt-3 text-xs font-medium text-muted-foreground">
								{dayName(day, now)}
							</h4>
							<ul>
								{thatDay.map((event) => (
									<ActivityRow
										key={event.id}
										event={event}
										hasPassword={hasPassword}
										rowRef={event.id === events[shown - PAGE]?.id ? firstOfMore : undefined}
									/>
								))}
							</ul>
						</div>
					))}
					{events.length > shown ? (
						<div className={CARD_ROW}>
							<Button
								variant="outline"
								size="sm"
								className={ROW_BUTTON}
								onClick={() => setShown(shown + PAGE)}
							>
								Show more
							</Button>
						</div>
					) : (
						data &&
						data.events.length >= MOST && (
							<p className={`${CARD_ROW} text-xs text-muted-foreground`}>
								These are the latest {MOST}. Anything older is not shown here.
							</p>
						)
					)}
				</>
			)}
		</AccountCard>
	);
}

function ActivityRow({
	event,
	hasPassword,
	rowRef,
}: {
	event: AuditActivity;
	hasPassword: boolean;
	/** For the row that takes the focus when "Show more" brings it. */
	rowRef: Ref<HTMLLIElement> | undefined;
}) {
	const concern = concernOf(event);
	return (
		<li
			ref={rowRef}
			tabIndex={rowRef ? -1 : undefined}
			data-concern={concern}
			// Red for the one that means someone knows the password, and a grey bar for a slip. More
			// than a colour either way, which not everyone sees: the bar, and the words under it.
			className={cn(
				"border-l-2 border-transparent px-4 py-2 outline-none",
				concern === "alarm" && "border-destructive",
				concern === "notice" && "border-muted-foreground/40",
			)}
		>
			<p className={cn("font-medium", concern === "alarm" && "text-destructive")}>
				{describeActivity(event)}
			</p>
			<p className="break-words text-xs text-muted-foreground">
				{new Date(event.at).toLocaleTimeString(undefined, { timeStyle: "short" })}
				{event.device && ` · ${event.device}`}
				{event.ip && ` · ${event.ip}`}
			</p>
			{concern && (
				<p className={cn("text-xs", concern === "alarm" ? "font-medium" : "text-muted-foreground")}>
					{ifNotYou(concern, hasPassword)}
				</p>
			)}
		</li>
	);
}
