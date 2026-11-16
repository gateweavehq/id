import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { referenceIn } from "./lib/error-reference";

/**
 * Keeps a failure's reference with it on the way out of a server function. Only an error's
 * message crosses to the browser, and the reference of a failed database query may be further in:
 * Better Auth throws its own `Failed to get session` with the database's error as the cause. The
 * page would show the reference where it is rendered on the server and lose it in the browser.
 * So such an error leaves with the reference in its message, and nothing else of its cause.
 * Everything else, a redirect or a "not found" among it, is thrown as it was.
 */
const keepReference = createMiddleware({ type: "function" }).server(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		const reference = referenceIn(error);
		if (!reference || !(error instanceof Error) || referenceIn(new Error(error.message))) {
			throw error;
		}
		throw new Error(`${error.message} (reference ${reference})`);
	}
});

/**
 * The framework's own guard for server functions, said here because saying anything here takes
 * it away: without a start instance the framework puts this in front of every server-function
 * request, and with one it uses the instance's `requestMiddleware` and nothing else. It answers
 * 403 to a request another site made (`Sec-Fetch-Site`, then `Origin`, then `Referer`). Only
 * server functions: the provider's endpoints are called from other origins by design.
 */
const sameSiteOnly = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({
	requestMiddleware: [sameSiteOnly],
	functionMiddleware: [keepReference],
}));
