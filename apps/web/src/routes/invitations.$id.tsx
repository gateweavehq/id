import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthPage } from "#/components/auth-page";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import { type InvitationForYou, roleName, workspaceFailure } from "#/lib/workspace";

/**
 * One invitation, for the person it is for. Someone signed in with another address sees what anyone
 * sees of an invitation that does not exist, which is why this page has to say whose account it is.
 */
export const Route = createFileRoute("/invitations/$id")({
	beforeLoad: async ({ params, search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/invitations/$id", params });
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login", search: { redirect: `/invitations/${params.id}` } });
		}
		return { email: session.user.email };
	},
	component: InvitationPage,
});

function InvitationPage() {
	const { id } = Route.useParams();
	const { email } = Route.useRouteContext();
	const router = useRouter();
	const [invitation, setInvitation] = useState<InvitationForYou | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "missing" | "failed">("loading");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useDocumentTitle("Invitation");

	useEffect(() => {
		authClient
			.$fetch<InvitationForYou>(`/workspaces/invitation?${new URLSearchParams({ id })}`)
			.then((result) => {
				if (result.error) {
					setState(result.error.status === 404 ? "missing" : "failed");
					return;
				}
				setInvitation(result.data);
				setState("ready");
			})
			.catch(() => setState("failed"));
	}, [id]);

	async function answer(path: string) {
		setPending(true);
		setError(null);
		const result = await authClient.$fetch(path, {
			method: "POST",
			body: { invitationId: id },
		});
		if (result.error) {
			setPending(false);
			setError(workspaceFailure(result.error));
			return;
		}
		await router.navigate({ to: "/workspaces" });
	}

	if (state === "missing") {
		return (
			<AuthPage
				title="That invitation is not here"
				description={
					<>
						It may have expired or been withdrawn, or it may be for another address. You are signed
						in as <span className="break-all text-foreground">{email}</span>.
					</>
				}
			>
				<Button asChild variant="outline" className="w-full">
					<Link to="/workspaces">Your workspaces</Link>
				</Button>
			</AuthPage>
		);
	}

	if (state !== "ready" || !invitation) {
		return (
			<AuthPage title="Invitation">
				{state === "failed" ? (
					<p role="alert" className="text-sm text-destructive">
						This invitation could not be loaded.
					</p>
				) : (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)}
			</AuthPage>
		);
	}

	return (
		<AuthPage
			title="You have been invited"
			description={
				<>
					{invitation.inviter ? (
						<span className="break-all text-foreground">{invitation.inviter}</span>
					) : (
						"Someone"
					)}{" "}
					invited you to a workspace, as {roleName(invitation.role).toLowerCase()}.
				</>
			}
		>
			<p className="rounded-lg border p-4 text-sm font-medium break-words">
				{invitation.workspace}
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<LiveButton disabled={pending} onClick={() => answer("/organization/accept-invitation")}>
					Join workspace
				</LiveButton>
				<LiveButton
					variant="ghost"
					disabled={pending}
					onClick={() => answer("/organization/reject-invitation")}
				>
					Decline
				</LiveButton>
			</div>
		</AuthPage>
	);
}
