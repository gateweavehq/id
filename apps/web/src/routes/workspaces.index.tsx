import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import {
	type InvitationForYou,
	roleName,
	slugFrom,
	type WorkspaceSummary,
	workspaceFailure,
	workspaceName,
	workspaceSlug,
} from "#/lib/workspace";

export const Route = createFileRoute("/workspaces/")({
	beforeLoad: async () => {
		if (!(await getSession())) {
			throw redirect({ to: "/login", search: { redirect: "/workspaces" } });
		}
	},
	component: WorkspacesPage,
});

interface Listing {
	workspaces: WorkspaceSummary[];
	invitations: InvitationForYou[];
}

/**
 * Everywhere this person belongs. It loads in the browser, as their sessions do, so a page that was
 * open a while still shows what is true.
 */
function WorkspacesPage() {
	const [listing, setListing] = useState<Listing | null>(null);
	const [error, setError] = useState<string | null>(null);
	useDocumentTitle("Workspaces");

	const load = useCallback(async () => {
		const result = await authClient.$fetch<Listing>("/workspaces/list");
		if (result.error) setError(result.error.message ?? "Your workspaces could not be loaded");
		else setListing(result.data);
	}, []);

	useEffect(() => {
		load().catch(() => setError("Your workspaces could not be loaded"));
	}, [load]);

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
				<Link
					to="/account"
					className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Your account
				</Link>
			</header>

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			{listing && listing.invitations.length > 0 && (
				<section aria-labelledby="invitations-heading" className="space-y-4">
					<h2 id="invitations-heading" className="text-sm font-semibold">
						Invitations for you
					</h2>
					<ul className="divide-y rounded-lg border text-sm">
						{listing.invitations.map((invitation) => (
							<li key={invitation.id}>
								<Link
									to="/invitations/$id"
									params={{ id: invitation.id }}
									className="block px-4 py-3 hover:bg-accent"
								>
									<p className="font-medium break-words">{invitation.workspace}</p>
									<p className="break-words text-xs text-muted-foreground">
										{roleName(invitation.role)}
										{invitation.inviter && `, invited by ${invitation.inviter}`}
									</p>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}

			<section aria-labelledby="yours-heading" className="space-y-4">
				<h2 id="yours-heading" className="text-sm font-semibold">
					Your workspaces
				</h2>
				{listing === null ? (
					!error && <p className="text-sm text-muted-foreground">Loading…</p>
				) : listing.workspaces.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						You are not in a workspace yet. Make one below, or ask someone to invite you.
					</p>
				) : (
					<ul className="divide-y rounded-lg border text-sm">
						{listing.workspaces.map((workspace) => (
							<li key={workspace.id}>
								<Link
									to="/workspaces/$slug"
									params={{ slug: workspace.slug }}
									className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent"
								>
									<span className="min-w-0 font-medium break-words">{workspace.name}</span>
									<span className="shrink-0 text-xs text-muted-foreground">
										{roleName(workspace.role)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>

			<NewWorkspace />
		</main>
	);
}

function NewWorkspace() {
	const router = useRouter();
	const [name, setName] = useState("");
	/** What someone typed as the address. Until they do, it follows the name. */
	const [chosenSlug, setChosenSlug] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const slug = chosenSlug ?? slugFrom(name);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const body = { name: name.trim(), slug };
		const refused =
			workspaceName.safeParse(body.name).error ?? workspaceSlug.safeParse(body.slug).error;
		if (refused) {
			setError(refused.issues[0]?.message ?? "Check the name and the address.");
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.$fetch("/organization/create", { method: "POST", body });
		if (result.error) {
			setPending(false);
			setError(workspaceFailure(result.error));
			return;
		}
		await router.navigate({ to: "/workspaces/$slug", params: { slug } });
	}

	return (
		<section aria-labelledby="new-heading" className="space-y-4">
			<h2 id="new-heading" className="text-sm font-semibold">
				Make a workspace
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="workspace-name">Name</Label>
					<Input
						id="workspace-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={60}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="workspace-slug">Address</Label>
					<Input
						id="workspace-slug"
						value={slug}
						onChange={(event) => setChosenSlug(event.target.value)}
						maxLength={40}
						autoCapitalize="none"
						spellCheck={false}
						aria-describedby="workspace-slug-hint"
						required
					/>
					<p id="workspace-slug-hint" className="text-xs text-muted-foreground">
						Lowercase letters, digits and hyphens. It is how pages here name the workspace.
					</p>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Make workspace
				</LiveButton>
			</form>
		</section>
	);
}
