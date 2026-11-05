import { env } from "cloudflare:workers";
import { SEND_CODE, USE_CODE } from "./sign-up";

const PATHS = [SEND_CODE, USE_CODE].map((path) => `/api/auth${path}`);

/** More than the work behind these answers normally takes on a deployed Worker. */
const FLOOR_MS = 1000;

/**
 * Whether an address has an account or a way in decides how much these paths do: a stranger's answer
 * comes after two reads, and someone else's after a Durable Object and a write as well. Nothing else
 * about the answers tells them apart, so nor should this, and it costs a person a moment they are
 * already spending on waiting for an email. "Sign-up" in docs/architecture.md.
 */
export function evenAnswer(request: Request, answer: Promise<Response>): Promise<Response> {
	if (!PATHS.includes(new URL(request.url).pathname)) return answer;
	const floor = Number(env.ANSWER_FLOOR_MS || FLOOR_MS);
	return Promise.all([answer, new Promise((resolve) => setTimeout(resolve, floor))]).then(
		([response]) => response,
	);
}
