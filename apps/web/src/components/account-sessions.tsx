import { useRef, useState } from "react";
import {
	AccountCard,
	CARD_ACTION_ROW,
	CARD_ROW,
	LoadFailure,
	ROW_BUTTON,
	useFocusBack,
	useLoaded,
} from "#/components/account-section";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { describeBrowser } from "#/lib/device";
import { signedInWith } from "#/lib/sign-in-method";

interface ActiveSession {
	id: string;
	token: string;
	createdAt: Date | string;
	updatedAt?: Date | string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	/** How it was made, which only the server writes. */
	signInMethod?: string | null;
}

const NOT_LOADED = "Your sessions could not be loaded";
const NOT_DONE = "That did not work. Please try again.";

/** This browser first, then the most recent. */
function inOrder(sessions: ActiveSession[], currentId: string): ActiveSession[] {
	return [...sessions].sort((a, b) => {
		if (a.id === currentId) return -1;
		if (b.id === currentId) return 1;
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});
}

function momentOf(date: Date | string): string {
	return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dayOf(date: Date | string): string {
	return new Date(date).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "Chrome on Windows · with a passkey". A session is a browser's, whatever device it is on. */
function nameOf(session: ActiveSession): string {
	const how = signedInWith(session.signInMethod);
	return how
		? `${describeBrowser(session.userAgent)} · ${how}`
		: describeBrowser(session.userAgent);
}

const listSessions = () => authClient.listSessions();

/**
 * Everywhere the person is signed in, where they can end any of it. It loads in the browser, not
 * with the page: dates read in the person's own time zone and language, which a server cannot know,
 * and a page that was open a while still shows what is true.
 *
 * Signing out other browsers keeps this session, so a stolen copy of this browser's cookie survives
 * it, and nobody can tell which of their sessions was copied. Signing out of everything ends that
 * too. It asks for no password, since whoever holds the cookie can use up the tries at one.
 *
 * The two that end more than one session ask first, here on the page, and then make the same
 * request they always made.
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
	/** What is being ended: a session's id, or one of the two that end several. */
	const [ending, setEnding] = useState<string | null>(null);
	const [asking, setAsking] = useState<"others" | "everything" | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	// Each question takes the place of the button that asked it.
	const othersButton = useFocusBack<HTMLButtonElement>(asking === "others");
	const everythingButton = useFocusBack<HTMLButtonElement>(asking === "everything");

	const others = sessions?.filter((session) => session.id !== currentId) ?? [];

	/** Ends what `action` ends, then says so where a screen reader hears it and a person sees it. */
	async function end(
		what: string,
		action: () => Promise<{ error: { message?: string | undefined } | null }>,
		said: string,
	) {
		setError(null);
		setDone(null);
		setEnding(what);
		try {
			const result = await action();
			if (result.error) {
				setError(result.error.message ?? NOT_DONE);
				return;
			}
			await reload();
			setAsking(null);
			setDone(said);
			// The button that was pressed went with its row, and the focus must not go with it.
			heading.current?.focus();
		} catch {
			setError(NOT_DONE);
		} finally {
			setEnding(null);
		}
	}

	async function signOutOfEverything() {
		setError(null);
		setEnding("everything");
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
			setEnding(null);
		}
	}

	return (
		<AccountCard
			id="sessions-heading"
			title="Where you are signed in"
			headingRef={heading}
			aside={
				others.length > 0 &&
				asking !== "others" && (
					<Button
						ref={othersButton}
						variant="ghost"
						size="sm"
						disabled={ending !== null}
						onClick={() => setAsking("others")}
					>
						Sign out other browsers
					</Button>
				)
			}
		>
			{error && (
				<p role="alert" className={`${CARD_ROW} text-destructive`}>
					{error}
				</p>
			)}
			{/* In the page from the start, or a screen reader would not hear it arrive. */}
			<p aria-live="polite" className={done ? `${CARD_ROW} text-muted-foreground` : "sr-only"}>
				{done}
			</p>
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
			{asking === "others" && (
				<div className={CARD_ACTION_ROW}>
					<p id="sign-out-others-means">
						{others.length === 1
							? "This signs you out in 1 other browser. You stay signed in here."
							: `This signs you out in ${others.length} other browsers. You stay signed in here.`}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="destructive"
							size="sm"
							aria-describedby="sign-out-others-means"
							disabled={ending !== null}
							onClick={() =>
								end(
									"others",
									() => authClient.revokeOtherSessions(),
									"Your other browsers are signed out.",
								)
							}
						>
							{ending === "others" ? "Signing out…" : "Yes, sign out other browsers"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={ending !== null}
							// The button that was pressed has gone, and this is the one that changes nothing.
							autoFocus
							onClick={() => setAsking(null)}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}
			{sessions === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : (
				<ul className="divide-y">
					{inOrder(sessions, currentId).map((session) => (
						<li key={session.id} className="flex items-center justify-between gap-4 px-4 py-3">
							<div className="min-w-0">
								<p className="break-words font-medium">{nameOf(session)}</p>
								<p className="break-words text-xs text-muted-foreground">
									Signed in {momentOf(session.createdAt)}
									{session.ipAddress && ` from ${session.ipAddress}`}
									{session.updatedAt && ` · Last active ${dayOf(session.updatedAt)}`}
								</p>
							</div>
							{session.id === currentId ? (
								<span className="shrink-0 text-xs text-muted-foreground">This browser</span>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className={`shrink-0 ${ROW_BUTTON}`}
									// Two rows can be the same browser, so the name says when as well.
									aria-label={`Sign out ${describeBrowser(session.userAgent)}, signed in ${momentOf(session.createdAt)}`}
									disabled={ending !== null}
									onClick={() =>
										end(
											session.id,
											() => authClient.revokeSession({ token: session.token }),
											`${describeBrowser(session.userAgent)} is signed out.`,
										)
									}
								>
									{ending === session.id ? "Signing out…" : "Sign out"}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			{asking === "everything" ? (
				<div className={CARD_ACTION_ROW}>
					<p id="sign-out-everything-means">
						This signs you out everywhere, here too, and you will have to sign in again.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="destructive"
							size="sm"
							aria-describedby="sign-out-everything-means"
							disabled={ending !== null}
							onClick={signOutOfEverything}
						>
							{ending === "everything" ? "Signing out…" : "Yes, sign out of everything"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={ending !== null}
							autoFocus
							onClick={() => setAsking(null)}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<div className={CARD_ACTION_ROW}>
					<p className="text-muted-foreground">
						Ends every session, this one too, in case someone has a copy of it.
					</p>
					<Button
						ref={everythingButton}
						variant="outline"
						size="sm"
						disabled={ending !== null}
						onClick={() => setAsking("everything")}
					>
						Sign out of everything
					</Button>
				</div>
			)}
		</AccountCard>
	);
}
