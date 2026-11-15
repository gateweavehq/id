import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * The app a signed-in person is being asked about, and nothing else of it. Someone who may not sign in
 * to it cannot get as far as being asked, and asking directly tells them nothing.
 */
export const getAppToAllow = createServerFn({ method: "GET" })
	.validator(z.string().max(200))
	.handler(async ({ data: clientId }) => {
		const { db, getAuth } = await import("#/server/auth");
		const { schema } = await import("#/server/db");
		const { hostOfUris } = await import("#/server/auth/app-row");
		const { maySignIn } = await import("#/server/auth/who-may-sign-in");
		const { eq } = await import("drizzle-orm");
		const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
		if (!session) return null;
		const app = await db
			.select({
				name: schema.oauthClient.name,
				workspaceId: schema.oauthClient.referenceId,
				redirectUris: schema.oauthClient.redirectUris,
			})
			.from(schema.oauthClient)
			.where(eq(schema.oauthClient.clientId, clientId))
			.get();
		if (!app) return null;
		const about = { name: app.name, host: hostOfUris(app.redirectUris) };
		if (!app.workspaceId) return { ...about, workspace: null };
		const identity = { app: clientId, workspace: app.workspaceId };
		if (!(await maySignIn(db, { user: session.user, app: identity }))) return null;
		const workspace = await db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, app.workspaceId))
			.get();
		return workspace ? { ...about, workspace: workspace.name } : null;
	});

/**
 * What to tell a member about their workspace's rule on two-factor sign-in, on the way to one of its
 * apps. Null for anyone the app would not admit anyway, and for an app with no workspace, so asking
 * tells nobody whether a workspace they are not in has the rule, or that it exists. Null as well
 * where the workspace asks for nothing, since there is then no rule to tell a member about, and the
 * page would otherwise say that it asks.
 */
export const getSecondFactorAsked = createServerFn({ method: "GET" })
	.validator(z.string().max(200))
	.handler(async ({ data: clientId }) => {
		const { db, getAuth } = await import("#/server/auth");
		const { schema } = await import("#/server/db");
		const { hasPasskey } = await import("#/server/auth/passkeys");
		const { appIn, maySignIn, signedInAsAsked } = await import("#/server/auth/who-may-sign-in");
		const { and, eq } = await import("drizzle-orm");
		const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
		if (!session) return null;
		const client = await db
			.select({ name: schema.oauthClient.name, metadata: schema.oauthClient.metadata })
			.from(schema.oauthClient)
			.where(eq(schema.oauthClient.clientId, clientId))
			.get();
		// Read as the check reads it, so that this page and the check cannot disagree about whose it is.
		const app = appIn(client?.metadata);
		if (!client || !app?.workspace) return null;
		const { user } = session;
		if (!(await maySignIn(db, { user, app }))) return null;
		const [workspace, owed, passkey, password] = await Promise.all([
			db
				.select({ name: schema.organization.name, asks: schema.organization.requireTwoFactor })
				.from(schema.organization)
				.where(eq(schema.organization.id, app.workspace))
				.get(),
			signedInAsAsked(db, { user, app, sessionId: session.session.id }).then((asAsked) => !asAsked),
			hasPasskey(db, user.id),
			db
				.select({ id: schema.account.id })
				.from(schema.account)
				.where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")))
				.get(),
		]);
		// Only a plain "no" is one, as in the check.
		if (!workspace || workspace.asks === false) return null;
		const twoFactorOn = (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
		return {
			app: client.name,
			workspace: workspace.name,
			/** Whether this session falls short of the rule. False once they have signed in with more. */
			owed,
			/** Whether they have something to sign in again with: a passkey, or a password and a code. */
			ready: passkey || (twoFactorOn && password !== undefined),
			hasPassword: password !== undefined,
		};
	});
