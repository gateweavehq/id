import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Notice } from "#/components/notice";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { WorkspaceApps } from "#/components/workspace-apps";
import { WorkspaceGroups } from "#/components/workspace-groups";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions, getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import {
	can,
	INVITED_ROLES,
	roleName,
	WORKSPACE_ROLES,
	type WorkspaceDetails,
	type WorkspaceMember,
	type WorkspaceRole,
	workspaceFailure,
	workspaceName,
} from "#/lib/workspace";

export const Route = createFileRoute("/workspaces/$slug")({
	beforeLoad: async ({ params, search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/workspaces/$slug", params });
		if (!(await getSession())) {
			throw redirect({ to: "/login", search: { redirect: `/workspaces/${params.slug}` } });
		}
	},
	loader: () => getAuthOptions(),
	component: WorkspacePage,
});

const SELECT =
	"h-9 rounded-md border border-input bg-background px-2 text-base shadow-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 md:text-sm";

/** Sends a change, and returns what went wrong if it did. */
async function send(path: string, body: object): Promise<string | null> {
	try {
		const result = await authClient.$fetch(path, { method: "POST", body });
		return result.error ? workspaceFailure(result.error) : null;
	} catch (caught) {
		return caught instanceof Error ? caught.message : "Something went wrong";
	}
}

function WorkspacePage() {
	const { slug } = Route.useParams();
	const [details, setDetails] = useState<WorkspaceDetails | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "missing" | "failed">("loading");
	const legal = useLegalLinks();
	useDocumentTitle(details?.workspace.name ?? "Workspace");

	const load = useCallback(async () => {
		const result = await authClient.$fetch<WorkspaceDetails>(
			`/workspaces/get?${new URLSearchParams({ slug })}`,
		);
		if (result.error) {
			setState(result.error.status === 404 ? "missing" : "failed");
			return;
		}
		setDetails(result.data);
		setState("ready");
	}, [slug]);

	useEffect(() => {
		load().catch(() => setState("failed"));
	}, [load]);

	if (state === "missing") {
		return (
			<main>
				<Notice
					title="That workspace is not here"
					action={
						<Button asChild variant="outline">
							<Link to="/workspaces">Your workspaces</Link>
						</Button>
					}
				>
					It does not exist, or you are not a member of it.
				</Notice>
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="space-y-1">
				<Link
					to="/workspaces"
					className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Workspaces
				</Link>
				<h1 className="text-xl font-semibold tracking-tight break-words">
					{details?.workspace.name ?? "Workspace"}
				</h1>
			</header>

			{state === "failed" && (
				<p role="alert" className="text-sm text-destructive">
					This workspace could not be loaded.
				</p>
			)}
			{state === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}

			{details && (
				<>
					{can(details.you, "rename") && <RenameWorkspace details={details} reload={load} />}
					<Members details={details} reload={load} />
					{can(details.you, "invite") && <Invitations details={details} reload={load} />}
					{details.appsEnabled && <WorkspaceGroups details={details} reload={load} />}
					{details.appsEnabled && can(details.you, "manageApps") && (
						<WorkspaceApps details={details} reload={load} />
					)}
					<LeaveWorkspace details={details} />
					{can(details.you, "delete") && <DeleteWorkspace details={details} />}
				</>
			)}

			<LegalLinks links={legal} />
		</main>
	);
}

interface SectionProps {
	details: WorkspaceDetails;
	reload: () => Promise<void>;
}

function RenameWorkspace({ details, reload }: SectionProps) {
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = String(new FormData(event.currentTarget).get("name")).trim();
		setError(null);
		setSaved(false);
		const refused = workspaceName.safeParse(name).error;
		if (refused) {
			setError(refused.issues[0]?.message ?? "Check the name.");
			return;
		}
		setPending(true);
		const failure = await send("/organization/update", {
			organizationId: details.workspace.id,
			data: { name },
		});
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		setSaved(true);
		await reload();
	}

	return (
		<section aria-labelledby="name-heading" className="space-y-4">
			<h2 id="name-heading" className="text-sm font-semibold">
				Name
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="workspace-name">Workspace name</Label>
					<Input
						id="workspace-name"
						name="name"
						maxLength={60}
						defaultValue={details.workspace.name}
						required
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{saved && (
					<p role="status" className="text-sm text-muted-foreground">
						Saved.
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Save
				</LiveButton>
			</form>
		</section>
	);
}

function Members({ details, reload }: SectionProps) {
	const [error, setError] = useState<string | null>(null);

	async function run(path: string, body: object) {
		setError(null);
		const failure = await send(path, { organizationId: details.workspace.id, ...body });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<section aria-labelledby="members-heading" className="space-y-4">
			<h2 id="members-heading" className="text-sm font-semibold">
				Members
			</h2>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<ul className="divide-y rounded-lg border text-sm">
				{details.members.map((member) => (
					<MemberRow key={member.id} member={member} details={details} run={run} />
				))}
			</ul>
		</section>
	);
}

function MemberRow({
	member,
	details,
	run,
}: {
	member: WorkspaceMember;
	details: WorkspaceDetails;
	run: (path: string, body: object) => Promise<void>;
}) {
	const { you } = details;
	const [askingToRemove, setAskingToRemove] = useState(false);
	const isYou = member.id === you.memberId;
	const owners = details.members.filter(({ role }) => role === "owner").length;
	// Stepping down cannot be taken back by the person who does it, so it is on offer only for handing
	// over to another owner. Someone who wants out can leave.
	const mayChange = !isYou || (member.role === "owner" && owners > 1);
	const roles = WORKSPACE_ROLES.filter(
		(to) => to === member.role || (mayChange && can(you, "changeRole", { role: member.role, to })),
	);
	const canRemove = !isYou && can(you, "removeMember", { role: member.role });

	return (
		<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
			<div className="min-w-0">
				<p className="font-medium break-words">
					{member.name}
					{isYou && <span className="font-normal text-muted-foreground"> (you)</span>}
				</p>
				<p className="break-all text-xs text-muted-foreground">{member.email}</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{roles.length > 1 ? (
					<select
						aria-label={`Role of ${member.name}`}
						className={SELECT}
						value={member.role}
						onChange={(event) =>
							run("/organization/update-member-role", {
								memberId: member.id,
								role: event.target.value as WorkspaceRole,
							})
						}
					>
						{roles.map((role) => (
							<option key={role} value={role}>
								{roleName(role)}
							</option>
						))}
					</select>
				) : (
					<span className="text-xs text-muted-foreground">{roleName(member.role)}</span>
				)}
				{canRemove &&
					(askingToRemove ? (
						<>
							<Button
								variant="destructive"
								size="sm"
								aria-label={`Yes, remove ${member.name}`}
								onClick={() => run("/organization/remove-member", { memberIdOrEmail: member.id })}
							>
								Yes, remove
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setAskingToRemove(false)}>
								Keep
							</Button>
						</>
					) : (
						<Button
							variant="ghost"
							size="sm"
							aria-label={`Remove ${member.name}`}
							onClick={() => setAskingToRemove(true)}
						>
							Remove
						</Button>
					))}
			</div>
		</li>
	);
}

function Invitations({ details, reload }: SectionProps) {
	const { email: canSendEmail } = Route.useLoaderData();
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		const email = String(form.get("email")).trim();
		setPending(true);
		setError(null);
		setSent(null);
		const failure = await send("/organization/invite-member", {
			organizationId: details.workspace.id,
			email,
			role: String(form.get("role")),
		});
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		setSent(`An invitation is on its way to ${email}.`);
		formElement.reset();
		await reload();
	}

	async function withdraw(invitationId: string) {
		setError(null);
		setSent(null);
		const failure = await send("/organization/cancel-invitation", { invitationId });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<section aria-labelledby="invite-heading" className="space-y-4">
			<h2 id="invite-heading" className="text-sm font-semibold">
				Invite someone
			</h2>
			{canSendEmail ? (
				<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
					<div className="space-y-2">
						<Label htmlFor="invite-email">Their email</Label>
						<Input id="invite-email" name="email" type="email" autoComplete="off" required />
					</div>
					<div className="space-y-2">
						<Label htmlFor="invite-role">Role</Label>
						<select
							id="invite-role"
							name="role"
							defaultValue="member"
							className={`${SELECT} w-full`}
						>
							{INVITED_ROLES.map((role) => (
								<option key={role} value={role}>
									{roleName(role)}
								</option>
							))}
						</select>
					</div>
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
						Send invitation
					</LiveButton>
				</form>
			) : (
				<p className="text-sm text-muted-foreground">
					This server does not send email, so it cannot send invitations.
				</p>
			)}

			{details.invitations.length > 0 && (
				<ul aria-label="Open invitations" className="divide-y rounded-lg border text-sm">
					{details.invitations.map((invitation) => (
						<li
							key={invitation.id}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
						>
							<div className="min-w-0">
								<p className="font-medium break-all">{invitation.email}</p>
								<p className="text-xs text-muted-foreground">
									{roleName(invitation.role)}, until{" "}
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

function LeaveWorkspace({ details }: { details: WorkspaceDetails }) {
	const router = useRouter();
	const [asked, setAsked] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function leave() {
		setError(null);
		const failure = await send("/organization/leave", { organizationId: details.workspace.id });
		if (failure) {
			setError(failure);
			setAsked(false);
			return;
		}
		await router.navigate({ to: "/workspaces" });
	}

	return (
		<section aria-labelledby="leave-heading" className="space-y-3">
			<h2 id="leave-heading" className="text-sm font-semibold">
				Leave this workspace
			</h2>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{asked ? (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="destructive"
						size="sm"
						aria-label={`Yes, leave ${details.workspace.name}`}
						onClick={leave}
					>
						Yes, leave
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setAsked(false)}>
						Stay
					</Button>
				</div>
			) : (
				<Button variant="outline" size="sm" onClick={() => setAsked(true)}>
					Leave
				</Button>
			)}
		</section>
	);
}

function DeleteWorkspace({ details }: { details: WorkspaceDetails }) {
	const router = useRouter();
	const [typed, setTyped] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const { name, id } = details.workspace;

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const failure = await send("/organization/delete", { organizationId: id });
		if (failure) {
			setPending(false);
			setError(failure);
			return;
		}
		await router.navigate({ to: "/workspaces" });
	}

	return (
		<section aria-labelledby="delete-heading" className="space-y-4">
			<h2 id="delete-heading" className="text-sm font-semibold">
				Delete this workspace
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-destructive/40 p-4">
				<p className="text-sm text-muted-foreground">
					This cannot be undone. Everyone loses their place in it, and its open invitations stop
					working.
				</p>
				<div className="space-y-2">
					<Label htmlFor="delete-confirm">Type its name to confirm</Label>
					<Input
						id="delete-confirm"
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
						autoComplete="off"
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton
					type="submit"
					variant="destructive"
					size="sm"
					disabled={pending || typed !== name}
				>
					Delete workspace
				</LiveButton>
			</form>
		</section>
	);
}
