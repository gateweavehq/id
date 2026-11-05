import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * The app a signed-in person is being asked about, and nothing else of it. Someone outside the
 * workspace it belongs to cannot get as far as being asked, and asking directly tells them nothing.
 */
export const getAppToAllow = createServerFn({ method: "GET" })
	.validator(z.string().max(200))
	.handler(async ({ data: clientId }) => {
		const { db, getAuth } = await import("#/server/auth");
		const { schema } = await import("#/server/db");
		const { hostOfUris } = await import("#/server/auth/app-row");
		const { and, eq } = await import("drizzle-orm");
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
		const workspace = await db
			.select({ name: schema.organization.name })
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
			.where(
				and(
					eq(schema.member.organizationId, app.workspaceId),
					eq(schema.member.userId, session.user.id),
				),
			)
			.get();
		return workspace ? { ...about, workspace: workspace.name } : null;
	});
