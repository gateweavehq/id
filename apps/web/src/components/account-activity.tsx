import { useEffect, useState } from "react";
import { type AuditActivity, describeActivity } from "#/lib/audit-event";
import { authClient } from "#/lib/auth-client";

/**
 * What has happened to this account lately, so someone can spot what was not them. It loads in the
 * browser, as their sessions do: dates read in their own time zone and language.
 */
export function AccountActivity() {
	const [events, setEvents] = useState<AuditActivity[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		authClient
			.$fetch<{ events: AuditActivity[] }>("/account/activity")
			.then((result) => {
				if (result.error) setError(result.error.message ?? "Your activity could not be loaded");
				else setEvents(result.data.events);
			})
			.catch(() => setError("Your activity could not be loaded"));
	}, []);

	return (
		<section aria-labelledby="activity-heading" className="space-y-4">
			<h2 id="activity-heading" className="text-sm font-semibold">
				Recent activity
			</h2>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{events === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{events.map((event) => (
						<li key={event.id} className="px-4 py-3">
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
		</section>
	);
}
