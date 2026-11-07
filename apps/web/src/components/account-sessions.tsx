import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { describeDevice } from "#/lib/device";

interface ActiveSession {
	id: string;
	token: string;
	createdAt: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
}

/** This device first, then the most recent. */
function inOrder(sessions: ActiveSession[], currentId: string): ActiveSession[] {
	return [...sessions].sort((a, b) => {
		if (a.id === currentId) return -1;
		if (b.id === currentId) return 1;
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});
}

/**
 * Everywhere the person is signed in, where they can end any of it. It loads in the browser, not
 * with the page: dates read in the person's own time zone and language, which a server cannot know,
 * and a page that was open a while still shows what is true.
 *
 * Signing out everywhere else keeps this session, so a stolen copy of this browser's cookie survives
 * it, and nobody can tell which of their sessions was copied. Signing out everywhere ends that too. It
 * asks for no password, since whoever holds the cookie can use up the tries at one.
 */
export function AccountSessions({
	currentId,
	onSignedOut,
}: {
	currentId: string;
	onSignedOut: () => void;
}) {
	const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const result = await authClient.listSessions();
		if (result.error) {
			setError(result.error.message ?? "Your sessions could not be loaded");
			return;
		}
		setSessions(result.data);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	async function run(action: () => Promise<{ error: { message?: string } | null }>) {
		setError(null);
		const result = await action();
		if (result.error) setError(result.error.message ?? "Something went wrong");
		await load();
	}

	async function signOutEverywhere() {
		setError(null);
		const result = await authClient.revokeSessions();
		if (result.error) {
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		onSignedOut();
	}

	const others = sessions?.filter((session) => session.id !== currentId) ?? [];

	return (
		<section aria-labelledby="sessions-heading" className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h2 id="sessions-heading" className="text-sm font-semibold">
					Where you are signed in
				</h2>
				{others.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => run(() => authClient.revokeOtherSessions())}
					>
						Sign out everywhere else
					</Button>
				)}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{sessions === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{inOrder(sessions, currentId).map((session) => (
						<li key={session.id} className="flex items-center justify-between gap-4 px-4 py-3">
							<div className="min-w-0">
								<p className="font-medium">{describeDevice(session.userAgent)}</p>
								<p className="break-words text-xs text-muted-foreground">
									Signed in{" "}
									{new Date(session.createdAt).toLocaleString(undefined, {
										dateStyle: "medium",
										timeStyle: "short",
									})}
									{session.ipAddress && ` from ${session.ipAddress}`}
								</p>
							</div>
							{session.id === currentId ? (
								<span className="shrink-0 text-xs text-muted-foreground">This device</span>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className="shrink-0"
									onClick={() => run(() => authClient.revokeSession({ token: session.token }))}
								>
									Sign out
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
				<p className="text-sm text-muted-foreground">
					Ends every session, this one too, in case someone has a copy of it.
				</p>
				<Button variant="outline" size="sm" onClick={signOutEverywhere}>
					Sign out everywhere
				</Button>
			</div>
		</section>
	);
}
