import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { getSession } from "#/lib/session";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		if (await getSession()) throw redirect({ to: "/account" });
	},
	component: Home,
});

function Home() {
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5">
					<h1 className="text-xl font-semibold tracking-tight">Gateweave ID</h1>
					<p className="text-sm text-muted-foreground">
						An open-source identity provider that runs on Cloudflare. It is in early development:
						for now you can create an account and sign in to it.
					</p>
				</div>
				<div className="flex gap-3">
					<Button asChild className="flex-1">
						<Link to="/login">Sign in</Link>
					</Button>
					<Button asChild variant="outline" className="flex-1">
						<Link to="/login" search={{ mode: "sign-up" }}>
							Create an account
						</Link>
					</Button>
				</div>
			</div>
		</main>
	);
}
