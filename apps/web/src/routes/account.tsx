import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/account")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) throw redirect({ to: "/login", search: { redirect: "/account" } });
		return { session };
	},
	component: AccountPage,
});

function AccountPage() {
	const { session } = Route.useRouteContext();
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

			<dl className="divide-y rounded-lg border text-sm">
				<div className="flex items-center justify-between gap-4 px-4 py-3">
					<dt className="text-muted-foreground">Name</dt>
					<dd className="font-medium">{session.user.name}</dd>
				</div>
				<div className="flex items-center justify-between gap-4 px-4 py-3">
					<dt className="text-muted-foreground">Email</dt>
					<dd className="font-medium">{session.user.email}</dd>
				</div>
			</dl>
		</main>
	);
}
