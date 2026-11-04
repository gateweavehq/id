import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { RouteError } from "./components/route-error";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		// Unknown URLs get the full-page "not found". The default renders it inside the deepest
		// layout that matched, which would run a layout without its data.
		notFoundMode: "root",
		defaultErrorComponent: RouteError,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
