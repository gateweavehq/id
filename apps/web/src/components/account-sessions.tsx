import { useRef, useState } from "react";
import {
	AccountCard,
	CARD_ACTION_ROW,
	CARD_ROW,
	LoadFailure,
	ROW_BUTTON,
	useLoaded,
} from "#/components/account-section";
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

const NOT_LOADED = "Your sessions could not be loaded";
const NOT_DONE = "That did not work. Please try again.";

/** This device first, then the most recent. */
function inOrder(sessions: ActiveSession[], currentId: string): ActiveSession[] {
	return [...sessions].sort((a, b) => {
		if (a.id === currentId) return -1;
		if (b.id === currentId) return 1;
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});
}

const listSessions = () => authClient.listSessions();

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
	const {
		data: sessions,
		failure,
		loading,
		reload,
	} = useLoaded<ActiveSession[]>(listSessions, NOT_LOADED);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);

	async function run(action: () => Promise<{ error: { message?: string } | null }>) {
		setError(null);
		setPending(true);
		try {
			const result = await action();
			if (result.error) setError(result.error.message ?? NOT_DONE);
		} catch {
			setError(NOT_DONE);
		} finally {
			setPending(false);
		}
		await reload();
	}

	async function signOutEverywhere() {
		setError(null);
		setPending(true);
		try {
			const result = await authClient.revokeSessions();
			if (result.error) {
				setError(result.error.message ?? NOT_DONE);
				return;
			}
			onSignedOut();
		} catch {
			setError(NOT_DONE);
		} finally {
			setPending(false);
		}
	}

	const others = sessions?.filter((session) => session.id !== currentId) ?? [];

	return (
		<AccountCard
			id="sessions-heading"
			title="Where you are signed in"
			headingRef={heading}
			aside={
				others.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						disabled={pending}
						onClick={() => run(() => authClient.revokeOtherSessions())}
					>
						Sign out everywhere else
					</Button>
				)
			}
		>
			{error && (
				<p role="alert" className={`${CARD_ROW} text-destructive`}>
					{error}
				</p>
			)}
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
			{sessions === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : (
				<ul className="divide-y">
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
									className={`shrink-0 ${ROW_BUTTON}`}
									disabled={pending}
									onClick={() => run(() => authClient.revokeSession({ token: session.token }))}
								>
									Sign out
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<div className={CARD_ACTION_ROW}>
				<p className="text-muted-foreground">
					Ends every session, this one too, in case someone has a copy of it.
				</p>
				<Button variant="outline" size="sm" disabled={pending} onClick={signOutEverywhere}>
					Sign out everywhere
				</Button>
			</div>
		</AccountCard>
	);
}
