import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AccountActivity } from "#/components/account-activity";
import { AccountApps } from "#/components/account-apps";
import { AccountDelete } from "#/components/account-delete";
import { AccountPasskeys } from "#/components/account-passkeys";
import { AccountPassword } from "#/components/account-password";
import { AccountProfile } from "#/components/account-profile";
import { AccountSessions } from "#/components/account-sessions";
import { AccountTwoFactor } from "#/components/account-two-factor";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions, getSession, hasPassword, ownsThisServer } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/account")({
	beforeLoad: async ({ search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/account" });
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: { redirect: "/account" } });
		return { session };
	},
	loader: async () => {
		const [password, options, owner] = await Promise.all([
			hasPassword(),
			getAuthOptions(),
			ownsThisServer(),
		]);
		return { hasPassword: password, passkeys: options.passkeys, apps: options.apps, owner };
	},
	component: AccountPage,
});

function AccountPage() {
	const { session } = Route.useRouteContext();
	const data = Route.useLoaderData();
	const router = useRouter();
	const legal = useLegalLinks();
	// In place, because a word on the sign-in page would be something anyone could put in a link.
	const [deleted, setDeleted] = useState(false);
	useDocumentTitle("Account");

	if (deleted) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">Your account is deleted</h1>
				<p role="status" className="text-sm text-muted-foreground">
					Apps you signed in to keep what they already hold about you, so delete your account in
					each of them too.
				</p>
				<Button asChild variant="outline" size="sm">
					<a href="/login">Go to sign-in</a>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex items-center justify-between">
				<h1 className="text-xl font-semibold tracking-tight">Your account</h1>
				<Button
					variant="ghost"
					size="sm"
					onClick={async () => {
						await authClient.signOut();
						await router.invalidate();
						await router.navigate({ to: "/login" });
					}}
				>
					Sign out
				</Button>
			</header>

			<AccountProfile name={session.user.name} email={session.user.email} />
			<section aria-labelledby="workspaces-heading" className="space-y-4">
				<h2 id="workspaces-heading" className="text-sm font-semibold">
					Workspaces
				</h2>
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">The teams you belong to, and invitations.</p>
					<Button asChild variant="outline" size="sm">
						<Link to="/workspaces">Open workspaces</Link>
					</Button>
				</div>
			</section>
			{data.owner && (
				<section aria-labelledby="server-heading" className="space-y-4">
					<h2 id="server-heading" className="text-sm font-semibold">
						This server
					</h2>
					<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
						<p className="text-sm text-muted-foreground">
							You run it. Who can make an account here.
						</p>
						<Button asChild variant="outline" size="sm">
							<Link to="/server">Open settings</Link>
						</Button>
					</div>
				</section>
			)}
			<AccountPassword email={session.user.email} hasPassword={data.hasPassword} />
			{data.hasPassword && (
				<AccountTwoFactor
					enabled={session.user.twoFactorEnabled === true}
					email={session.user.email}
				/>
			)}
			{data.passkeys && <AccountPasskeys />}
			{/* A changed password replaces this session, and with it what the list has to show. */}
			<AccountSessions key={session.session.id} currentId={session.session.id} />
			{data.apps && <AccountApps />}

			<AccountActivity />
			<AccountDelete
				email={session.user.email}
				hasPassword={data.hasPassword}
				onDeleted={() => setDeleted(true)}
			/>

			<LegalLinks links={legal} />
		</main>
	);
}
