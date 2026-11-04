import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	return getAuth().api.getSession({ headers: getRequestHeaders() });
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled } = await import("#/server/auth");
	return { github: githubEnabled, email: emailEnabled };
});
