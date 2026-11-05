import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { LegalLinks, useLegalLinks } from "#/components/legal-links";
import { Notice } from "#/components/notice";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { getLegalLinks } from "#/lib/session";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Gateweave ID" },
			{
				name: "description",
				content:
					"Gateweave ID, an open-source identity provider for Cloudflare. Early development.",
			},
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
		],
	}),
	// The same for every page and set when the Worker is deployed, so fetched once per visit.
	loader: () => getLegalLinks(),
	staleTime: Number.POSITIVE_INFINITY,
	shouldReload: false,
	shellComponent: RootDocument,
	notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Toaster />
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Page not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Go to Gateweave ID</Link>
					</Button>
				}
			>
				Check the address, or start from the home page.
			</Notice>
			<LegalLinks links={useLegalLinks()} />
		</main>
	);
}
