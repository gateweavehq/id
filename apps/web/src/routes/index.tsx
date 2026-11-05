import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { getSession } from "#/lib/session";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		if (await getSession()) throw redirect({ to: "/account" });
	},
	component: Home,
});

function Home() {
	const legal = useLegalLinks();
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<img src="/favicon.svg" alt="" width={40} height={40} />
				<div className="space-y-1.5">
					<h1 className="text-xl font-semibold tracking-tight">Gateweave ID</h1>
					<p className="text-sm text-muted-foreground">
						One account that signs you in to the apps connected to it. It is an open-source identity
						provider that runs on Cloudflare, in early development.
					</p>
				</div>
				<div className="flex gap-3">
					<Button asChild className="flex-1">
						<Link to="/login">Sign in</Link>
					</Button>
					<Button asChild variant="outline" className="flex-1">
						<Link to="/signup">Create an account</Link>
					</Button>
				</div>
				<LegalLinks links={legal} />
			</div>
		</main>
	);
}
