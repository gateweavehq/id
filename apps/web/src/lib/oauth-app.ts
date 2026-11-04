import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

/** The name of the app a signed-in person is being asked about. Nothing else of it leaves here. */
export const getAppName = createServerFn({ method: "GET" })
	.validator(z.string().max(200))
	.handler(async ({ data: clientId }) => {
		const { db, getAuth } = await import("#/server/auth");
		const { schema } = await import("#/server/db");
		const { eq } = await import("drizzle-orm");
		if (!(await getAuth().api.getSession({ headers: getRequestHeaders() }))) return null;
		const app = await db
			.select({ name: schema.oauthClient.name })
			.from(schema.oauthClient)
			.where(eq(schema.oauthClient.clientId, clientId))
			.get();
		return app?.name ?? null;
	});
