import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { AccountActivity } from "#/components/account-activity";
import { AccountApps } from "#/components/account-apps";
import { AccountPasskeys } from "#/components/account-passkeys";
import { AccountPassword } from "#/components/account-password";
import { AccountProfile } from "#/components/account-profile";
import { AccountSessions } from "#/components/account-sessions";
import { AccountTwoFactor } from "#/components/account-two-factor";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions, getSession, hasPassword } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/account")({
	beforeLoad: async ({ search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/account" });
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: { redirect: "/account" } });
		return { session };
	},
	loader: async () => {
		const [password, options] = await Promise.all([hasPassword(), getAuthOptions()]);
		return { hasPassword: password, passkeys: options.passkeys, apps: options.apps };
	},
	component: AccountPage,
});

function AccountPage() {
	const { session } = Route.useRouteContext();
	const data = Route.useLoaderData();
	const router = useRouter();
	useDocumentTitle("Account");

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
		</main>
	);
}
