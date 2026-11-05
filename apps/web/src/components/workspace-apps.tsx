import { type FormEvent, useEffect, useRef, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import {
	type WorkspaceApp,
	type WorkspaceDetails,
	type WorkspaceGroup,
	workspaceFailure,
} from "#/lib/workspace";

const GUIDE = "https://github.com/gateweavehq/id/blob/main/docs/connect-an-app.md";

const TEXTAREA =
	"block min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none";

/** What was asked for, or what went wrong. */
async function post<Answer>(
	path: string,
	body: object,
): Promise<{ ok: true; data: Answer } | { ok: false; failure: string }> {
	try {
		const result = await authClient.$fetch<Answer>(path, { method: "POST", body });
		if (result.error) return { ok: false, failure: workspaceFailure(result.error) };
		return { ok: true, data: result.data as Answer };
	} catch (caught) {
		return {
			ok: false,
			failure: caught instanceof Error ? caught.message : "Something went wrong",
		};
	}
}

/** One to a line, as the field asks. */
function urisIn(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function hostOf(app: WorkspaceApp): string {
	const [first] = app.redirectUris;
	return first && URL.canParse(first) ? new URL(first).host : "";
}

interface Revealed {
	name: string;
	clientId: string;
	clientSecret: string;
	issuer: string;
}

function ReadOnly({ label, value }: { label: string; value: string }) {
	const id = `reveal-${label.toLowerCase().replaceAll(" ", "-")}`;
	return (
		<div className="space-y-1">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				readOnly
				value={value}
				autoComplete="off"
				className="font-mono text-sm"
				onFocus={(event) => event.currentTarget.select()}
			/>
		</div>
	);
}

/** The one time a secret can be seen. Only its hash is kept, so nothing can show it again. */
function SecretOnce({ revealed, onDone }: { revealed: Revealed; onDone: () => void }) {
	const heading = useRef<HTMLHeadingElement>(null);
	// It opens above the list, so replacing the secret of an app further down would leave it out of
	// sight, and this is the only look anyone gets.
	useEffect(() => heading.current?.focus(), []);
	return (
		<section
			aria-labelledby="secret-heading"
			className="space-y-4 rounded-lg border border-foreground/30 p-4"
		>
			<div className="space-y-1">
				<h3
					id="secret-heading"
					ref={heading}
					tabIndex={-1}
					className="text-sm font-semibold break-words outline-none"
				>
					Save the secret for {revealed.name} now
				</h3>
				<p className="text-sm text-muted-foreground">
					It is not kept, so it cannot be shown again. If it is lost, replace it.
				</p>
			</div>
			<ReadOnly label="Issuer" value={revealed.issuer} />
			<ReadOnly label="Client ID" value={revealed.clientId} />
			<ReadOnly label="Client secret" value={revealed.clientSecret} />
			<Button variant="outline" size="sm" onClick={onDone}>
				I have saved it
			</Button>
		</section>
	);
}

/** Who can use it, in words, so an admin need not open anything to find out. */
function whoCanUse(app: WorkspaceApp, groups: WorkspaceGroup[], workspaceName: string): string {
	if (app.groups.length === 0) return `Everyone in ${workspaceName} can use it.`;
	const named = groups.filter(({ id }) => app.groups.includes(id));
	const names = named.map(({ name }) => name).join(", ");
	if (named.every(({ members }) => members.length === 0)) {
		return `Only ${names} can use it, and nobody is in ${named.length === 1 ? "it" : "them"} yet.`;
	}
	return `Only ${names} can use it.`;
}

function WhoCanUse({
	app,
	groups,
	workspaceName,
	you,
	pending,
	onSave,
	onCancel,
}: {
	app: WorkspaceApp;
	groups: WorkspaceGroup[];
	workspaceName: string;
	you: string;
	pending: boolean;
	onSave: (groups: string[]) => void;
	onCancel: () => void;
}) {
	const [narrowed, setNarrowed] = useState(app.groups.length > 0);
	const [chosen, setChosen] = useState(app.groups);
	const name = `who-${app.clientId}`;
	// A group someone else deleted while this was open is no longer a choice.
	const picked = groups.filter(({ id }) => chosen.includes(id));
	const nobody = picked.every(({ members }) => members.length === 0);
	const youStay = picked.some(({ members }) => members.includes(you));

	function toggle(id: string, on: boolean) {
		setChosen((held) => (on ? [...held, id] : held.filter((other) => other !== id)));
	}

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				onSave(narrowed ? picked.map(({ id }) => id) : []);
			}}
		>
			<fieldset className="min-w-0 space-y-2">
				<legend className="max-w-full font-medium wrap-anywhere">Who can use {app.name}</legend>
				<label className="flex items-center gap-2 wrap-anywhere">
					<input type="radio" name={name} checked={!narrowed} onChange={() => setNarrowed(false)} />
					Everyone in {workspaceName}
				</label>
				<label className="flex items-center gap-2">
					<input
						type="radio"
						name={name}
						checked={narrowed}
						disabled={groups.length === 0}
						onChange={() => setNarrowed(true)}
					/>
					Only people in these groups
				</label>
				{groups.length === 0 && (
					<p className="text-muted-foreground">Make a group first, under Groups.</p>
				)}
				{narrowed && (
					<ul aria-label={`Groups that can use ${app.name}`} className="space-y-1 pl-6">
						{groups.map((group) => (
							<li key={group.id}>
								<label className="flex items-center gap-2 wrap-anywhere">
									<input
										type="checkbox"
										checked={chosen.includes(group.id)}
										onChange={(event) => toggle(group.id, event.target.checked)}
									/>
									{group.name}
								</label>
							</li>
						))}
					</ul>
				)}
			</fieldset>
			{narrowed && picked.length > 0 && (
				<p className="text-muted-foreground">
					{nobody
						? "Nobody is in these groups yet, so nobody could use it."
						: `Anyone outside these groups loses the app at once, and is asked again if they come back.${youStay ? "" : " That includes you."}`}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<LiveButton
					type="submit"
					size="sm"
					disabled={pending || (narrowed && picked.length === 0)}
					aria-label={`Save who can use ${app.name}`}
				>
					Save
				</LiveButton>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function AppRow({
	app,
	groups,
	workspaceId,
	workspaceName,
	you,
	reload,
	reveal,
}: {
	app: WorkspaceApp;
	groups: WorkspaceGroup[];
	workspaceId: string;
	workspaceName: string;
	you: string;
	reload: () => Promise<void>;
	reveal: (revealed: Revealed) => void;
}) {
	const [mode, setMode] = useState<"editing" | "who" | "replacing" | "deleting" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const which = { organizationId: workspaceId, clientId: app.clientId };

	/** What went wrong was about the last thing tried, and would read as being about the next. */
	function turnTo(next: typeof mode) {
		setError(null);
		setMode(next);
	}

	async function onEdit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError(null);
		const result = await post("/workspaces/apps/change", {
			...which,
			name: String(form.get("name")).trim(),
			redirectUris: urisIn(String(form.get("redirectUris"))),
		});
		setPending(false);
		if (!result.ok) {
			setError(result.failure);
			return;
		}
		setMode(null);
		await reload();
	}

	async function onSaveWho(chosen: string[]) {
		setPending(true);
		setError(null);
		const result = await post("/workspaces/apps/set-groups", {
			...which,
			groups: chosen,
			was: app.groups,
		});
		setPending(false);
		if (result.ok) setMode(null);
		else setError(result.failure);
		// Refused, this page may be out of date, and the form should open on how things stand.
		await reload();
	}

	async function onReplace() {
		setPending(true);
		setError(null);
		const result = await post<{ clientSecret: string }>("/workspaces/apps/replace-secret", which);
		setPending(false);
		if (!result.ok) {
			setError(result.failure);
			return;
		}
		setMode(null);
		reveal({
			name: app.name,
			clientId: app.clientId,
			clientSecret: result.data.clientSecret,
			issuer: window.location.origin,
		});
	}

	async function onDelete() {
		setPending(true);
		setError(null);
		const result = await post("/workspaces/apps/delete", which);
		setPending(false);
		if (!result.ok) {
			setError(result.failure);
			return;
		}
		await reload();
	}

	return (
		<li className="space-y-3 px-4 py-3 text-sm">
			<div className="min-w-0 space-y-0.5">
				<p className="font-medium break-words">{app.name}</p>
				<p className="break-words text-muted-foreground">{hostOf(app)}</p>
				<p className="font-mono text-xs break-all text-muted-foreground">{app.clientId}</p>
				<p className="break-words text-muted-foreground">{whoCanUse(app, groups, workspaceName)}</p>
			</div>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{mode === "editing" && (
				<form onSubmit={onEdit} className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor={`name-${app.clientId}`}>App name</Label>
						<Input id={`name-${app.clientId}`} name="name" defaultValue={app.name} required />
					</div>
					<div className="space-y-2">
						<Label htmlFor={`uris-${app.clientId}`}>Redirect URIs, one to a line</Label>
						<textarea
							id={`uris-${app.clientId}`}
							name="redirectUris"
							defaultValue={app.redirectUris.join("\n")}
							required
							wrap="off"
							className={TEXTAREA}
						/>
					</div>
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" size="sm" disabled={pending}>
							Save {app.name}
						</LiveButton>
						<Button type="button" variant="ghost" size="sm" onClick={() => turnTo(null)}>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{mode === "who" && (
				<WhoCanUse
					key={[...app.groups].sort().join()}
					app={app}
					groups={groups}
					workspaceName={workspaceName}
					you={you}
					pending={pending}
					onSave={onSaveWho}
					onCancel={() => turnTo(null)}
				/>
			)}
			{mode === "replacing" && (
				<div className="space-y-2">
					<p className="text-muted-foreground">
						The app stops working until it has the new secret. People stay signed in to it.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="destructive" size="sm" disabled={pending} onClick={onReplace}>
							Yes, replace the secret of {app.name}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => turnTo(null)}>
							Keep it
						</Button>
					</div>
				</div>
			)}
			{mode === "deleting" && (
				<div className="space-y-2">
					<p className="text-muted-foreground">
						This cannot be undone. Everyone is signed out of it at once.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="destructive" size="sm" disabled={pending} onClick={onDelete}>
							Yes, delete {app.name}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => turnTo(null)}>
							Keep it
						</Button>
					</div>
				</div>
			)}
			{mode === null && (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						aria-label={`Edit ${app.name}`}
						onClick={() => turnTo("editing")}
					>
						Edit
					</Button>
					<Button
						variant="outline"
						size="sm"
						aria-label={`Change who can use ${app.name}`}
						onClick={() => turnTo("who")}
					>
						Who can use it
					</Button>
					<Button
						variant="outline"
						size="sm"
						aria-label={`Replace the secret of ${app.name}`}
						onClick={() => turnTo("replacing")}
					>
						Replace secret
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Delete ${app.name}`}
						onClick={() => turnTo("deleting")}
					>
						Delete
					</Button>
				</div>
			)}
		</li>
	);
}

/** What a workspace's admins can do about its apps. The server decides again at each of these. */
export function WorkspaceApps({
	details,
	reload,
}: {
	details: WorkspaceDetails;
	reload: () => Promise<void>;
}) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [revealed, setRevealed] = useState<Revealed | null>(null);
	const { id: workspaceId, name: workspaceName } = details.workspace;

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		const name = String(form.get("name")).trim();
		setPending(true);
		setError(null);
		const result = await post<{ clientId: string; clientSecret: string }>("/workspaces/apps/add", {
			organizationId: workspaceId,
			name,
			redirectUris: urisIn(String(form.get("redirectUris"))),
		});
		setPending(false);
		if (!result.ok) {
			setError(result.failure);
			return;
		}
		formElement.reset();
		setRevealed({ name, ...result.data, issuer: window.location.origin });
		await reload();
	}

	return (
		<section aria-labelledby="apps-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="apps-heading" className="text-sm font-semibold">
					Apps
				</h2>
				<p className="text-sm text-muted-foreground">
					Your own apps can sign people in here. Only members of {workspaceName} can use them, and
					each person is asked first.{" "}
					<a
						href={GUIDE}
						className="underline underline-offset-4 hover:text-foreground"
						target="_blank"
						rel="noreferrer"
					>
						How to connect one
					</a>
				</p>
			</div>

			{revealed && (
				<SecretOnce
					key={revealed.clientSecret}
					revealed={revealed}
					onDone={() => setRevealed(null)}
				/>
			)}

			{details.apps.length > 0 && (
				<ul aria-label="Apps" className="divide-y rounded-lg border">
					{details.apps.map((app) => (
						<AppRow
							key={app.clientId}
							app={app}
							groups={details.groups}
							workspaceId={workspaceId}
							workspaceName={workspaceName}
							you={details.you.memberId}
							reload={reload}
							reveal={setRevealed}
						/>
					))}
				</ul>
			)}

			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="app-name">App name</Label>
					<Input id="app-name" name="name" required autoComplete="off" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="app-uris">Redirect URIs, one to a line</Label>
					<textarea
						id="app-uris"
						name="redirectUris"
						required
						wrap="off"
						placeholder="https://example.com/callback"
						className={TEXTAREA}
					/>
					<p className="text-xs text-muted-foreground">
						All on one host, which stays the app's for good.
					</p>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Add app
				</LiveButton>
			</form>
		</section>
	);
}
