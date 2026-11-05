import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type AllowedApp, scopeWords } from "#/lib/allowed-app";
import { authClient } from "#/lib/auth-client";

const NOT_LOADED = "The apps you allowed could not be loaded";
const NOT_TAKEN_BACK = "That app could not be taken back. Please try again.";

function dayOf(date: string | Date) {
	return new Date(date).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * The apps this person told ID they may have, and where they can change their mind. Only a workspace's
 * apps ask, so most people have none. It loads in the browser, as the sessions above it do, so that
 * dates read in their own time zone.
 */
export function AccountApps() {
	const [apps, setApps] = useState<AllowedApp[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [takenBack, setTakenBack] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);

	const load = useCallback(async () => {
		try {
			const result = await authClient.$fetch<{ apps: AllowedApp[] }>("/account/allowed-apps");
			if (result.error) setError(result.error.message ?? NOT_LOADED);
			else setApps(result.data.apps);
		} catch {
			setError(NOT_LOADED);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<section aria-labelledby="apps-heading" className="space-y-4">
			<h2
				id="apps-heading"
				ref={heading}
				tabIndex={-1}
				className="text-sm font-semibold outline-none"
			>
				Apps you allowed
			</h2>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{/* In the page from the start, or a screen reader would not hear it arrive. */}
			<p role="status" className={takenBack ? "text-sm text-muted-foreground" : "sr-only"}>
				{takenBack && `${takenBack} can no longer see your account.`}
			</p>
			{apps === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : apps.length === 0 ? (
				!takenBack && (
					<p className="text-sm text-muted-foreground">
						An app added by one of your workspaces asks before it can see your account. The ones you
						allow are listed here, where you can take them back.
					</p>
				)
			) : (
				<ul aria-labelledby="apps-heading" className="divide-y rounded-lg border text-sm">
					{apps.map((app) => (
						<AppRow
							key={app.clientId}
							app={app}
							onTakenBack={async (name) => {
								setTakenBack(name);
								await load();
								// The button that had the focus is gone with its row.
								heading.current?.focus();
							}}
							onError={setError}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function AppRow({
	app,
	onTakenBack,
	onError,
}: {
	app: AllowedApp;
	onTakenBack: (name: string) => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [asking, setAsking] = useState(false);
	const [pending, setPending] = useState(false);
	const opener = useRef<HTMLButtonElement>(null);
	const name = app.name || "This app";
	const scopes = scopeWords(app.scopes);

	function stopAsking() {
		setAsking(false);
		opener.current?.focus();
	}

	async function takeBack() {
		setPending(true);
		onError(null);
		try {
			const result = await authClient.$fetch("/account/allowed-apps/take-back", {
				method: "POST",
				body: { clientId: app.clientId },
			});
			if (result.error) {
				onError(result.error.message ?? NOT_TAKEN_BACK);
				stopAsking();
				return;
			}
			await onTakenBack(name);
		} catch {
			onError(NOT_TAKEN_BACK);
			stopAsking();
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="min-w-0">
				<p className="break-words font-medium">{name}</p>
				<p className="break-words text-xs text-muted-foreground">
					Added by an admin of {app.workspace}
					{app.host && ` · ${app.host}`}
				</p>
			</div>
			{scopes.length > 0 && (
				<ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
					{scopes.map((words) => (
						<li key={words}>{words}</li>
					))}
				</ul>
			)}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<p className="text-xs text-muted-foreground">
					Allowed {dayOf(app.allowedAt)}
					{app.lastSignIn && ` · Last signed in ${dayOf(app.lastSignIn)}`}
				</p>
				<Button
					ref={opener}
					variant="outline"
					size="sm"
					aria-label={`Take back ${name}`}
					aria-expanded={asking}
					disabled={pending}
					onClick={() => setAsking(!asking)}
				>
					Take back
				</Button>
			</div>
			{asking && (
				<div className="space-y-2">
					<p className="text-xs text-muted-foreground">
						It stops getting anything from your account at once, and has to ask you again next time.
						What it has already seen stays with it, and so does any session it keeps for you.
					</p>
					<div className="flex flex-wrap gap-2">
						{/* Buttons do not wrap, and an admin can give an app a long name. */}
						<Button
							variant="destructive"
							size="sm"
							aria-label={`Yes, take back ${name}`}
							disabled={pending}
							onClick={takeBack}
						>
							Yes, take back
						</Button>
						<Button variant="ghost" size="sm" disabled={pending} onClick={stopAsking}>
							Keep it
						</Button>
					</div>
				</div>
			)}
		</li>
	);
}
