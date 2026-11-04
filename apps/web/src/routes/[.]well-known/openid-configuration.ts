import { createFileRoute } from "@tanstack/react-router";

// Discovery has to sit at the root of the issuer, which is the bare origin, so it cannot live under
// Better Auth's /api/auth. Apps start here, and a deployment without a provider has nothing to say.
export const Route = createFileRoute("/.well-known/openid-configuration")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const { oauthProviderOpenIdConfigMetadata } = await import("@better-auth/oauth-provider");
				const { getAuth, oidcEnabled } = await import("../../server/auth");
				if (!oidcEnabled) return new Response("Not found", { status: 404 });
				return oauthProviderOpenIdConfigMetadata(getAuth())(request);
			},
		},
	},
});
