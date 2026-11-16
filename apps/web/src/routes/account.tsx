import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AccountActivity } from "#/components/account-activity";
import { AccountApps, AccountProducts } from "#/components/account-apps";
import { AccountDelete } from "#/components/account-delete";
import { AccountPasskeys } from "#/components/account-passkeys";
import { AccountPassword } from "#/components/account-password";
import { AccountProfile } from "#/components/account-profile";
import { AccountCard, AccountGroup, CARD_ACTION_ROW } from "#/components/account-section";
import { AccountSessions } from "#/components/account-sessions";
import { AccountSignIn } from "#/components/account-sign-in";
import { AccountTwoFactor } from "#/components/account-two-factor";
import { AccountWorkspaces } from "#/components/account-workspaces";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { carriesASignature } from "#/lib/oauth-flow";
import { getAuthOptions, getSession, getWaysToSignIn, ownsThisServer } from "#/lib/session";
import { isTwoFactor } from "#/lib/sign-in-method";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/account")({
	beforeLoad: async ({ search }) => {
		if (carriesASignature(search)) throw redirect({ to: "/account" });
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: { redirect: "/account" } });
		return { session };
	},
	loader: async () => {
		const [ways, options, owner] = await Promise.all([
			getWaysToSignIn(),
			getAuthOptions(),
			ownsThisServer(),
		]);
		return { ways, passkeys: options.passkeys, github: options.github, apps: options.apps, owner };
	},
	component: AccountPage,
});

/** The parts of the page, in the order they come, for the row of links at its top. */
const PARTS = [
	{ id: "profile", title: "Profile" },
	{ id: "sign-in", title: "Sign-in" },
	{ id: "devices", title: "Devices" },
	{ id: "apps", title: "Apps" },
	{ id: "activity", title: "Activity" },
] as const;

function AccountPage() {
	const { session } = Route.useRouteContext();
	const data = Route.useLoaderData();
	const router = useRouter();
	const legal = useLegalLinks();
	// In place, because a word on the sign-in page would be something anyone could put in a link.
	const [deleted, setDeleted] = useState(false);
	const [signedOut, setSignedOut] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	useDocumentTitle(deleted ? "Account deleted" : signedOut ? "Signed out" : "Account");

	if (signedOut) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">You are signed out everywhere</h1>
				<p role="status" className="text-sm text-muted-foreground">
					Every session of this account has ended, here and anywhere else. Apps you signed in to
					with it are told, and some may keep you signed in for a while.
				</p>
				<Button asChild variant="outline" size="sm">
					<a href="/login">Go to sign-in</a>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	if (deleted) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">Your account is deleted</h1>
				<p role="status" className="text-sm text-muted-foreground">
					Apps you signed in to keep what they already hold about you, and some may keep you signed
					in for a while, so delete your account in each of them too.
				</p>
				<Button asChild variant="outline" size="sm">
					<a href="/login">Go to sign-in</a>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	const twoFactorOn = session.user.twoFactorEnabled === true;
	const signedInWithTwoFactors = isTwoFactor(session.session.signInMethod);

	return (
		<main className="mx-auto max-w-2xl p-6 pt-16 sm:pt-24">
			<header className="flex items-start justify-between gap-4 pb-6">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">Your account</h1>
					<p className="break-words text-sm text-muted-foreground">{session.user.name}</p>
					<p className="break-words text-sm text-muted-foreground">{session.user.email}</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0"
					disabled={signingOut}
					onClick={async () => {
						setSigningOut(true);
						try {
							await authClient.signOut();
							await router.invalidate();
							await router.navigate({ to: "/login" });
						} finally {
							setSigningOut(false);
						}
					}}
				>
					Sign out
				</Button>
			</header>

			{/* It stays at the top of the window. A phone scrolls it sideways rather than the page. */}
			<nav
				aria-label="On this page"
				className="sticky top-0 z-10 -mx-6 border-b bg-background px-6"
			>
				<ul className="flex gap-5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{PARTS.filter((part) => part.id !== "apps" || data.apps).map((part) => (
						<li key={part.id} className="shrink-0">
							<a
								href={`#${part.id}`}
								className="flex h-11 items-center text-sm text-muted-foreground hover:text-foreground"
							>
								{part.title}
							</a>
						</li>
					))}
				</ul>
			</nav>

			<div className="space-y-12 pt-8">
				<AccountGroup id="profile" title="Profile">
					<AccountProfile name={session.user.name} email={session.user.email} />
					<AccountWorkspaces />
					{data.owner && (
						<AccountCard id="server-heading" title="This server">
							<div className={CARD_ACTION_ROW}>
								<p className="text-muted-foreground">You run it. Who can make an account here.</p>
								<Button asChild variant="outline" size="sm">
									<Link to="/server">Open settings</Link>
								</Button>
							</div>
						</AccountCard>
					)}
				</AccountGroup>

				<AccountGroup id="sign-in" title="Sign-in">
					<AccountSignIn
						has={{ ...data.ways, authenticator: twoFactorOn }}
						offered={{ passkeys: data.passkeys, github: data.github }}
					/>
					<AccountPassword email={session.user.email} hasPassword={data.ways.password} />
					{data.ways.password && (
						<AccountTwoFactor
							enabled={twoFactorOn}
							email={session.user.email}
							signedInWithTwoFactors={signedInWithTwoFactors}
						/>
					)}
					{data.passkeys && (
						<AccountPasskeys
							twoFactorOn={twoFactorOn}
							signedInWithTwoFactors={signedInWithTwoFactors}
						/>
					)}
				</AccountGroup>

				<AccountGroup id="devices" title="Devices">
					{/* A changed password replaces this session, and with it what the list has to show. */}
					<AccountSessions
						key={session.session.id}
						currentId={session.session.id}
						onSignedOut={() => setSignedOut(true)}
					/>
				</AccountGroup>

				{data.apps && (
					<AccountGroup id="apps" title="Apps">
						<AccountProducts />
						<AccountApps />
					</AccountGroup>
				)}

				<AccountGroup id="activity" title="Activity">
					<AccountActivity hasPassword={data.ways.password} />
				</AccountGroup>

				<AccountDelete
					email={session.user.email}
					hasPassword={data.ways.password}
					onDeleted={() => setDeleted(true)}
				/>

				<LegalLinks links={legal} />
			</div>
		</main>
	);
}
