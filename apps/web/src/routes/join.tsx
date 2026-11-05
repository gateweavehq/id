import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthPage } from "#/components/auth-page";
import { NewAccountForm } from "#/components/new-account-form";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

/**
 * Where an invitation from whoever runs this server leads. The token is in the part of the address after
 * the #, which a browser sends to nobody, so this reads it here rather than on the server.
 */
export const Route = createFileRoute("/join")({
	beforeLoad: ({ search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/join" });
	},
	loader: () => getSession(),
	component: JoinPage,
});

type Invitation =
	| { status: "reading" }
	| { status: "gone" }
	| { status: "failed"; message: string }
	| { status: "ready"; token: string; email: string };

function JoinPage() {
	const session = Route.useLoaderData();
	const router = useRouter();
	const [invitation, setInvitation] = useState<Invitation>({ status: "reading" });
	useDocumentTitle("Make your account");

	useEffect(() => {
		const token = window.location.hash.slice(1);
		if (!token) {
			setInvitation({ status: "gone" });
			return;
		}
		authClient
			.$fetch<{ email: string }>("/deployment/invitations/read", {
				method: "POST",
				body: { token },
			})
			.then((result) => {
				if (result.data) setInvitation({ status: "ready", token, email: result.data.email });
				else if (result.error.status === 404) setInvitation({ status: "gone" });
				else {
					setInvitation({
						status: "failed",
						message: result.error.message ?? "Your invitation could not be read. Try again.",
					});
				}
			});
	}, []);

	if (session) {
		return (
			<AuthPage
				title="You are signed in"
				description={
					<>
						You are signed in as <span className="text-foreground">{session.user.email}</span>. Sign
						out to use this invitation.
					</>
				}
			>
				<Button
					className="w-full"
					onClick={async () => {
						await authClient.signOut();
						await router.invalidate();
					}}
				>
					Sign out
				</Button>
			</AuthPage>
		);
	}

	if (invitation.status === "reading") {
		return (
			<AuthPage title="Make your account">
				<p className="text-sm text-muted-foreground">Reading your invitation…</p>
			</AuthPage>
		);
	}

	if (invitation.status === "failed") {
		return (
			<AuthPage title="Make your account">
				<p role="alert" className="text-sm text-destructive">
					{invitation.message}
				</p>
			</AuthPage>
		);
	}

	if (invitation.status === "gone") {
		return (
			<AuthPage
				title="This invitation does not work"
				description="It may have expired or been used. Ask whoever runs this server for another."
			>
				<p className="text-center text-sm text-muted-foreground">
					Already have an account?{" "}
					<Link
						to="/login"
						className="font-medium text-foreground underline-offset-4 hover:underline"
					>
						Sign in
					</Link>
				</p>
			</AuthPage>
		);
	}

	const { token, email } = invitation;
	return (
		<AuthPage
			agreeing
			title="Make your account"
			description={
				<>
					For <span className="text-foreground">{email}</span>. You will sign in with this address
					and the password you choose.
				</>
			}
		>
			<NewAccountForm
				action="Make my account"
				submit={async ({ name, newPassword }) => {
					const result = await authClient.$fetch("/deployment/invitations/accept", {
						method: "POST",
						body: { token, name, newPassword },
					});
					if (result.error) return result.error.message ?? "Something went wrong";
					await router.navigate({ to: "/workspaces" });
					return null;
				}}
			/>
		</AuthPage>
	);
}
