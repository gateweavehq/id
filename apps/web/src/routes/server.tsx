import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getSession, ownsThisServer } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import { workspaceFailure } from "#/lib/workspace";

/** Who can make an account on this server. To anyone but its owner, this page does not exist. */
export const Route = createFileRoute("/server")({
	beforeLoad: async ({ search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/server" });
		if (!(await getSession())) throw redirect({ to: "/login", search: { redirect: "/server" } });
		if (!(await ownsThisServer())) throw notFound();
	},
	component: ServerPage,
});

interface Invitation {
	id: string;
	email: string;
	expiresAt: string | Date;
}

interface Settings {
	signUp: "open" | "closed";
	invitations: Invitation[];
	sendsEmail: boolean;
}

async function send(path: string, body: object) {
	const result = await authClient.$fetch<Record<string, unknown>>(path, { method: "POST", body });
	return result.error
		? { failure: workspaceFailure(result.error), data: null }
		: { failure: null, data: result.data };
}

function ServerPage() {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const legal = useLegalLinks();
	useDocumentTitle("This server");

	const load = useCallback(async () => {
		const result = await authClient.$fetch<Settings>("/deployment/get");
		if (result.error)
			setError(result.error.message ?? "This server's settings could not be loaded");
		else setSettings(result.data);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex items-center justify-between gap-4">
				<h1 className="text-xl font-semibold tracking-tight">This server</h1>
				<Link to="/account" className="text-sm text-muted-foreground hover:text-foreground">
					Your account
				</Link>
			</header>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{settings === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<>
					<SignUp signUp={settings.signUp} reload={load} />
					<Invite settings={settings} reload={load} />
				</>
			)}
			<LegalLinks links={legal} />
		</main>
	);
}

function SignUp({ signUp, reload }: { signUp: Settings["signUp"]; reload: () => Promise<void> }) {
	const [asked, setAsked] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function change(to: Settings["signUp"]) {
		setError(null);
		setAsked(false);
		const { failure } = await send("/deployment/sign-up", { signUp: to });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<section aria-labelledby="sign-up-heading" className="space-y-4">
			<h2 id="sign-up-heading" className="text-sm font-semibold">
				Who can make an account
			</h2>
			<div className="space-y-3 rounded-lg border p-4">
				<p className="text-sm">
					{signUp === "open"
						? "Anyone can make an account here, and make workspaces."
						: "Only people invited, by you or by a workspace, can make an account here. Only you can make workspaces."}
				</p>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{signUp === "open" ? (
					<Button variant="outline" size="sm" onClick={() => change("closed")}>
						Close sign-up
					</Button>
				) : asked ? (
					<div className="space-y-3">
						<p className="text-sm text-muted-foreground">
							Anyone who finds this server could then make an account and a workspace.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button variant="destructive" size="sm" onClick={() => change("open")}>
								Yes, open it
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setAsked(false)}>
								Keep it closed
							</Button>
						</div>
					</div>
				) : (
					<Button variant="outline" size="sm" onClick={() => setAsked(true)}>
						Open sign-up
					</Button>
				)}
			</div>
		</section>
	);
}

function Invite({ settings, reload }: { settings: Settings; reload: () => Promise<void> }) {
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<string | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const email = String(new FormData(formElement).get("email")).trim();
		setPending(true);
		setError(null);
		setSent(null);
		setLink(null);
		setCopied(false);
		const { failure, data } = await send("/deployment/invitations/create", { email });
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		if (typeof data?.link === "string") setLink(data.link);
		else setSent(`An invitation is on its way to ${email}.`);
		formElement.reset();
		await reload();
	}

	async function withdraw(id: string) {
		setError(null);
		setSent(null);
		setLink(null);
		const { failure } = await send("/deployment/invitations/cancel", { id });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<section aria-labelledby="invite-heading" className="space-y-4">
			<h2 id="invite-heading" className="text-sm font-semibold">
				Invite someone to this server
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="invite-email">Their email</Label>
					<Input id="invite-email" name="email" type="email" autoComplete="off" required />
				</div>
				{!settings.sendsEmail && (
					<p className="text-sm text-muted-foreground">
						This server does not send email, so you get a link to pass on yourself. Nothing checks
						the address, so whoever opens the link gets an account with it.
					</p>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{sent && (
					<p role="status" className="text-sm break-words text-muted-foreground">
						{sent}
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Invite
				</LiveButton>
				{link && (
					<div className="space-y-2 border-t pt-4">
						<Label htmlFor="invite-link">Send them this link</Label>
						<Input id="invite-link" readOnly value={link} className="font-mono text-xs" />
						<p className="text-sm text-muted-foreground">
							It works once, for 7 days. You will not see it again, though you can invite them again
							for a new one.
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={async () => {
								await navigator.clipboard.writeText(link);
								setCopied(true);
							}}
						>
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
				)}
			</form>

			{settings.invitations.length > 0 && (
				<ul aria-label="Open invitations" className="divide-y rounded-lg border text-sm">
					{settings.invitations.map((invitation) => (
						<li
							key={invitation.id}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
						>
							<div className="min-w-0">
								<p className="font-medium break-all">{invitation.email}</p>
								<p className="text-xs text-muted-foreground">
									Until{" "}
									{new Date(invitation.expiresAt).toLocaleDateString(undefined, {
										dateStyle: "medium",
									})}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="shrink-0"
								aria-label={`Withdraw the invitation to ${invitation.email}`}
								onClick={() => withdraw(invitation.id)}
							>
								Withdraw
							</Button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
