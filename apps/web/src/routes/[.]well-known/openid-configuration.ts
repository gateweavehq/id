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
				const answer = await oauthProviderOpenIdConfigMetadata(getAuth())(request);
				// The provider always offers these two. Introspection is closed here, as `OIDC_CLOSED_PATHS`
				// says, and `claims` is dropped from every request by `membersOnlyToWorkspaceApps`.
				const offered = Object.entries((await answer.json()) as Record<string, unknown>);
				const metadata = offered.filter(([name]) => !name.startsWith("introspection_"));
				const said = { ...Object.fromEntries(metadata), claims_parameter_supported: false };
				return new Response(JSON.stringify(said), {
					status: answer.status,
					headers: answer.headers,
				});
			},
		},
	},
});
