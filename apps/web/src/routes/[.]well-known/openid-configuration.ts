import { createFileRoute } from "@tanstack/react-router";

const SECRET_METHODS = ["client_secret_basic", "client_secret_post"];
const WITHHELD = /^(dpop_|(token|revocation)_endpoint_auth_signing_)/;

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
				// The provider offers everything it has code for. Apps act on this, so it says what they can
				// use here. Introspection is closed, as `OIDC_CLOSED_PATHS` says, and `claims` is dropped from
				// every request by `membersOnlyToWorkspaceApps`. No app can be registered for a signed
				// assertion, nobody tests DPoP, and every app has pairwise subjects. `select_account` is
				// refused for want of a page.
				const offered = Object.entries((await answer.json()) as Record<string, unknown>);
				const metadata = offered.filter(
					([name]) => !name.startsWith("introspection_") && !WITHHELD.test(name),
				);
				const said = {
					...Object.fromEntries(metadata),
					claims_parameter_supported: false,
					token_endpoint_auth_methods_supported: SECRET_METHODS,
					revocation_endpoint_auth_methods_supported: SECRET_METHODS,
					subject_types_supported: ["pairwise"],
					prompt_values_supported: ["none", "login", "consent", "create"],
				};
				return new Response(JSON.stringify(said), {
					status: answer.status,
					headers: answer.headers,
				});
			},
		},
	},
});
