import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "#/server/auth";
import { evenAnswer } from "#/server/auth/even-answer";
import { countedByWhoSentIt } from "#/server/auth/workers-address";

// Here because the handler counts a request first of all, before anything in it can step in.
const handle = async ({ request }: { request: Request }) =>
	evenAnswer(request, getAuth().handler(await countedByWhoSentIt(request)));

export const Route = createFileRoute("/api/auth/$")({
	server: { handlers: { GET: handle, POST: handle } },
});
