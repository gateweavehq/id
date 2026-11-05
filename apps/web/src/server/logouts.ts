import { env } from "cloudflare:workers";
import { signJWT } from "better-auth/plugins/jwt";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, getAuth } from "./auth";
import { schema } from "./db";

// "Logouts an app missed" in docs/architecture.md.

const owed = z.object({ clientId: z.string(), sub: z.string(), sid: z.string() });

/** A back-channel logout the provider's three tries could not deliver: who, and which session. */
export type UndeliveredLogout = z.infer<typeof owed>;

/** The app has just had three tries over about 20 seconds, so the next waits a minute, then doubles. */
const FIRST_RETRY_SECONDS = 60;
const LONGEST_RETRY_SECONDS = 6 * 60 * 60;
/** About 20 hours of tries, after which the person's session in that app is left to run out. */
const ATTEMPTS = 12;
const LOGOUT_TOKEN_LIFETIME_SECONDS = 120;
const DELIVERY_TIMEOUT_MS = 5_000;

function retryDelay(attempt: number): number {
	const first = Number(env.LOGOUT_RETRY_SECONDS) || FIRST_RETRY_SECONDS;
	return Math.min(first * 2 ** (attempt - 1), LONGEST_RETRY_SECONDS);
}

/**
 * Hands a logout the app missed to the queue. Only who and which session go on it, not the token: a
 * logout token lives two minutes, and apps refuse old ones, so every try signs a new one.
 */
export async function queueLogout(logout: UndeliveredLogout): Promise<void> {
	if (!env.LOGOUTS) {
		console.warn(
			`back-channel logout to client ${logout.clientId} missed, with no queue to try again`,
		);
		return;
	}
	await env.LOGOUTS.send(logout, { delaySeconds: retryDelay(1) });
}

/** The queue's consumer: tries each logout again, and puts it back for later while the app is down. */
export async function deliverMissedLogouts(batch: MessageBatch<unknown>): Promise<void> {
	for (const message of batch.messages) {
		const logout = owed.safeParse(message.body);
		const outcome = logout.success ? await deliver(logout.data) : "done";
		if (outcome === "again" && message.attempts < ATTEMPTS) {
			message.retry({ delaySeconds: retryDelay(message.attempts + 1) });
			continue;
		}
		if (outcome === "again" && logout.success) {
			console.warn(
				`back-channel logout to client ${logout.data.clientId} given up after ${ATTEMPTS} tries`,
			);
		}
		message.ack();
	}
}

async function deliver({ clientId, sub, sid }: UndeliveredLogout): Promise<"done" | "again"> {
	// The app may have been deleted, or stopped taking logouts, since.
	const client = await db
		.select({
			uri: schema.oauthClient.backchannelLogoutUri,
			disabled: schema.oauthClient.disabled,
		})
		.from(schema.oauthClient)
		.where(eq(schema.oauthClient.clientId, clientId))
		.get();
	if (!client?.uri || client.disabled) return "done";

	const context = await getAuth().$context;
	const plugins = (context.options.plugins ?? []) as { id: string; options?: unknown }[];
	const jwt = plugins.find((plugin) => plugin.id === "jwt")?.options as
		| Parameters<typeof signJWT>[1]["options"]
		| undefined;
	const iat = Math.floor(Date.now() / 1000);
	const token = await signJWT({ context } as unknown as Parameters<typeof signJWT>[0], {
		options: jwt,
		payload: {
			iss: jwt?.jwt?.issuer ?? context.baseURL,
			aud: clientId,
			sub,
			sid,
			iat,
			exp: iat + LOGOUT_TOKEN_LIFETIME_SECONDS,
			jti: crypto.randomUUID(),
			events: { "http://schemas.openid.net/event/backchannel-logout": {} },
		},
		header: { typ: "logout+jwt" },
	});
	try {
		const response = await fetch(client.uri, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({ logout_token: token }),
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			redirect: "manual",
		});
		if (response.status === 200 || response.status === 204) return "done";
		console.warn(`back-channel logout to client ${clientId} returned ${response.status}`);
		// A refusal would only repeat (section 2.5 of the specification).
		return response.status >= 500 ? "again" : "done";
	} catch (error) {
		console.warn(`back-channel logout to client ${clientId} failed: ${errorName(error)}`);
		return "again";
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
