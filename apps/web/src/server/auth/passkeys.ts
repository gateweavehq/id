import { getAuthenticatorName, passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	freshSessionMiddleware,
} from "better-auth/api";
import { and, eq, exists, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { describeDevice } from "../../lib/device";
import {
	TWO_FACTORS_TO_ADD_A_PASSKEY,
	TWO_FACTORS_TO_REMOVE_A_PASSKEY,
} from "../../lib/sign-in-method";
import type { Database } from "../db";
import { schema } from "../db";
import { factorsBehindOneFactor } from "./another-factor";

const AUTHENTICATE_OPTIONS = "/passkey/generate-authenticate-options";
const VERIFY_AUTHENTICATION = "/passkey/verify-authentication";
const REGISTER_OPTIONS = "/passkey/generate-register-options";
const VERIFY_REGISTRATION = "/passkey/verify-registration";
const RENAME = "/passkey/update-passkey";
const REMOVE = "/account/remove-passkey";

/** Replaced by `REMOVE`, which knows about a person's other ways to sign in. */
export const PASSKEY_CLOSED_PATHS = ["/passkey/delete-passkey"];

const ALREADY_REGISTERED = {
	code: "PASSKEY_ALREADY_REGISTERED",
	message: "This passkey could not be added.",
};
const INVALID_NAME = {
	code: "INVALID_PASSKEY_NAME",
	message: "Enter a name of at most 100 characters.",
};
const LAST_WAY = {
	code: "LAST_WAY_TO_SIGN_IN",
	message: "This is your only way to sign in. Add a password or another passkey first.",
};
const NOT_FOUND = { code: "PASSKEY_NOT_FOUND", message: "There is no such passkey." };

const passkeyName = z.string().trim().min(1).max(100);

/** A way back in that leaves no row among someone's accounts. */
export async function hasPasskey(db: Database, userId: string): Promise<boolean> {
	const found = await db
		.select({ id: schema.passkey.id })
		.from(schema.passkey)
		.where(eq(schema.passkey.userId, userId))
		.limit(1)
		.get();
	return found !== undefined;
}

export interface PasskeySettings {
	/** Where ID is served. Each passkey is bound to its host for good. */
	baseURL: string;
	/** Whether someone can sign in with GitHub here, so that it counts as a way to sign in. */
	githubSignIn: boolean;
}

/**
 * Better Auth's passkey plugin, held to what signing in to everything else a person uses demands.
 * See "Passkeys" in docs/architecture.md for why each of these differs from what it does by default.
 */
export function passkeyPlugins(db: Database, { baseURL, githubSignIn }: PasskeySettings) {
	const { hostname, origin } = new URL(baseURL);
	const plugin = passkey({
		rpID: hostname,
		rpName: "Gateweave ID",
		// Without this the plugin also takes any trusted origin the browser reports.
		origin,
		authenticatorSelection: {
			// There is no step that asks for an address first, so a passkey that the browser cannot
			// find by itself could never be used.
			residentKey: "required",
			userVerification: "required",
		},
		registration: {
			// This runs before anything is stored.
			afterVerification: async ({ ctx, verification }) => {
				const info = verification.registrationInfo;
				// For the types: the plugin has already refused an answer without this.
				if (!info) return;
				const [taken] = await db
					.select({ id: schema.passkey.id })
					.from(schema.passkey)
					.where(eq(schema.passkey.credentialID, info.credential.id));
				if (taken) throw APIError.from("BAD_REQUEST", ALREADY_REGISTERED);
				return {
					// A name asked for up front would also go to the authenticator as the account's name,
					// and a person choosing a passkey needs to see their address there.
					name:
						getAuthenticatorName(info.aaguid) ??
						describeDevice(ctx.headers?.get("user-agent") ?? undefined),
				};
			},
		},
	});
	const fields = plugin.schema.passkey.fields;
	return [
		{
			...plugin,
			schema: {
				passkey: {
					...plugin.schema.passkey,
					fields: {
						...fields,
						// The WebAuthn spec requires this, and the plugin's own index does not enforce it.
						// Sign-in finds a passkey by this alone.
						credentialID: { ...fields.credentialID, unique: true },
					},
				},
			},
		},
		passkeyRules(db, githubSignIn),
	];
}

function passkeyRules(db: Database, githubSignIn: boolean) {
	// A password is an account row too. A GitHub link only counts where GitHub sign-in is on.
	const accountsThatSignIn = githubSignIn ? ["credential", "github"] : ["credential"];

	return {
		id: "passkey-rules",
		endpoints: {
			removePasskey: createAuthEndpoint(
				REMOVE,
				{
					method: "POST",
					body: z.object({ id: z.string() }),
					// As recent a sign-in as adding one takes: a stolen cookie should not be able to take
					// away what the person would use to get back in. A hook below also asks that the
					// sign-in showed two factors.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const { id } = ctx.body;
					const userId = ctx.context.session.user.id;
					const otherPasskeys = db
						.select({ id: schema.passkey.id })
						.from(schema.passkey)
						.where(and(eq(schema.passkey.userId, userId), ne(schema.passkey.id, id)));
					const accounts = db
						.select({ id: schema.account.id })
						.from(schema.account)
						.where(
							and(
								eq(schema.account.userId, userId),
								inArray(schema.account.providerId, accountsThatSignIn),
							),
						);
					// One statement, so that two removals at once cannot each count on the other's passkey.
					const removed = await db
						.delete(schema.passkey)
						.where(
							and(
								eq(schema.passkey.id, id),
								eq(schema.passkey.userId, userId),
								or(exists(otherPasskeys), exists(accounts)),
							),
						)
						.returning({ id: schema.passkey.id });
					if (removed.length > 0) return ctx.json({ status: true });

					const [kept] = await db
						.select({ id: schema.passkey.id })
						.from(schema.passkey)
						.where(and(eq(schema.passkey.id, id), eq(schema.passkey.userId, userId)));
					throw kept
						? APIError.from("BAD_REQUEST", LAST_WAY)
						: APIError.from("NOT_FOUND", NOT_FOUND);
				},
			),
		},
		hooks: {
			before: [
				{
					// Both steps, so that a ceremony begun by a session that showed two factors cannot be
					// finished by one that did not.
					matcher: (ctx) => ctx.path === REGISTER_OPTIONS || ctx.path === VERIFY_REGISTRATION,
					handler: createAuthMiddleware(async (ctx) => {
						// A passkey passes a workspace's rule on two-factor sign-in by itself. Someone who
						// holds one of a person's factors, such as their GitHub account, could otherwise add
						// their own and be both. A first one is taken on trust: see `another-factor.ts`.
						const has = await factorsBehindOneFactor(db, ctx);
						if (has?.authenticator || has?.passkey) {
							throw APIError.from("FORBIDDEN", TWO_FACTORS_TO_ADD_A_PASSKEY);
						}
					}),
				},
				{
					matcher: (ctx) => ctx.path === REMOVE,
					handler: createAuthMiddleware(async (ctx) => {
						// Whoever holds only a person's password or GitHub account could otherwise remove
						// their passkey, be left with an account that has no second factor, and enrol their
						// own on trust. Any passkey, not only the last: a session with one factor takes no
						// second factor away. Renaming one takes nothing away, and is not held to this.
						const has = await factorsBehindOneFactor(db, ctx);
						if (has?.passkey) throw APIError.from("FORBIDDEN", TWO_FACTORS_TO_REMOVE_A_PASSKEY);
					}),
				},
				{
					matcher: (ctx) => ctx.path === RENAME || ctx.path === VERIFY_REGISTRATION,
					handler: createAuthMiddleware(async (ctx) => {
						const name = ctx.body?.name;
						if (name !== undefined && !passkeyName.safeParse(name).success) {
							// Someone who cleared the field has not gone over any limit.
							const tooLong = typeof name === "string" && name.trim().length > 0;
							throw APIError.from(
								"BAD_REQUEST",
								tooLong ? INVALID_NAME : { ...INVALID_NAME, message: "Enter a name." },
							);
						}
						// Adding a passkey takes a recent sign-in, and this would make the session recent
						// again for whoever holds it.
						if (ctx.body?.createSession) {
							throw APIError.from("BAD_REQUEST", {
								code: "SESSION_NOT_OFFERED",
								message: "Adding a passkey does not sign anyone in.",
							});
						}
					}),
				},
			],
		},
		rateLimit: [
			{
				// Every visit to the sign-in page asks for options, for the browser to offer a passkey.
				pathMatcher: (path: string) => path === AUTHENTICATE_OPTIONS,
				window: 60,
				max: 60,
			},
			{
				pathMatcher: (path: string) => path === VERIFY_AUTHENTICATION,
				window: 60,
				max: 30,
			},
			{
				pathMatcher: (path: string) =>
					path === REGISTER_OPTIONS ||
					path === VERIFY_REGISTRATION ||
					path === RENAME ||
					path === REMOVE,
				window: 60,
				max: 20,
			},
		],
	} satisfies BetterAuthPlugin;
}
