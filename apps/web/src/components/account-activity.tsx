import { useRef } from "react";
import { AccountCard, CARD_ROW, LoadFailure, useLoaded } from "#/components/account-section";
import { type AuditActivity, describeActivity } from "#/lib/audit-event";
import { authClient } from "#/lib/auth-client";

const NOT_LOADED = "Your activity could not be loaded";

const listActivity = () => authClient.$fetch<{ events: AuditActivity[] }>("/account/activity");

/**
 * What has happened to this account lately, so someone can spot what was not them. It loads in the
 * browser, as their sessions do: dates read in their own time zone and language.
 */
export function AccountActivity() {
	const { data, failure, loading, reload } = useLoaded(listActivity, NOT_LOADED);
	const heading = useRef<HTMLHeadingElement>(null);
	const events = data?.events ?? null;

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
				<ul className="divide-y">
					{events.map((event) => (
						<li key={event.id} className={CARD_ROW}>
							<p className="font-medium">{describeActivity(event)}</p>
							<p className="break-words text-xs text-muted-foreground">
								{new Date(event.at).toLocaleString(undefined, {
									dateStyle: "medium",
									timeStyle: "short",
								})}
								{event.device && ` · ${event.device}`}
								{event.ip && ` · ${event.ip}`}
							</p>
						</li>
					))}
				</ul>
			)}
		</AccountCard>
	);
}
