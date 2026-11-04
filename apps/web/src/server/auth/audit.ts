import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import {
	createAuthEndpoint,
	createAuthMiddleware,
	getSessionFromCtx,
	isAPIError,
	NO_STORE_HEADERS,
	sessionMiddleware,
} from "better-auth/api";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { AuditActivity, AuditEventType } from "../../lib/audit-event";
import { describeDevice } from "../../lib/device";
import type { Database } from "../db";
import { schema } from "../db";

export interface AuditDetails {
	userId?: string | null | undefined;
	app?: string | null | undefined;
	ip?: string | null | undefined;
	device?: string | null | undefined;
	detail?: string | null | undefined;
}

/**
 * Writes an event, after the response. Everything is after it for the same reason: a failed sign-in
 * writes a row only for an address with an account, and a response that took longer for those would
 * say which addresses have one, as sending email in the background already avoids.
 *
 * It never throws and never waits. A failed write must not stop anyone signing in, and shows in the
 * logs, with the type and the kind of error only, since the log is not to spread what this one holds.
 */
export type RecordEvent = (
	type: AuditEventType,
	details: AuditDetails | (() => Promise<AuditDetails | undefined>),
) => void;

export function auditRecorder(
	db: Database,
	runInBackground: ((work: Promise<unknown>) => void) | undefined,
): RecordEvent {
	return (type, details) => {
		const work = write(db, type, details);
		if (runInBackground) runInBackground(work);
	};
}

async function write(
	db: Database,
	type: AuditEventType,
	details: AuditDetails | (() => Promise<AuditDetails | undefined>),
) {
	try {
		const found = typeof details === "function" ? await details() : details;
		if (!found) return;
		await db
			.insert(schema.auditEvent)
			.values({ id: crypto.randomUUID(), at: new Date(), type, ...found })
			.run();
	} catch (error) {
		console.error(
			`audit: could not record ${type}: ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/** Where a request came from, in the form this log keeps. */
export function whereFrom(headers: Headers | undefined | null) {
	const userAgent = headers?.get("user-agent");
	return {
		ip: headers?.get("cf-connecting-ip") ?? null,
		device: userAgent ? describeDevice(userAgent) : null,
	};
}

/**
 * How each path signs someone in. A session made anywhere else, such as a new one for changing a
 * password, is not someone signing in.
 */
const SIGN_IN_METHODS: Record<string, string> = {
	"/sign-in/email": "password",
	"/sign-in/email-otp": "code",
	"/passkey/verify-authentication": "passkey",
	"/two-factor/verify-totp": "totp",
	"/two-factor/verify-backup-code": "recovery_code",
};
const PROVIDER_CALLBACK = "/callback/:id";

function signInMethod(context: GenericEndpointContext | null): string | undefined {
	if (!context) return undefined;
	if (context.path === PROVIDER_CALLBACK) return context.params?.id;
	// Someone with a session here is showing that their authenticator works, and the session this makes
	// replaces theirs.
	if (context.path === "/two-factor/verify-totp" && context.context.session) return undefined;
	return SIGN_IN_METHODS[context.path];
}

/** What turns two-factor sign-in on or off, the only thing that changes a person at these paths. */
const TWO_FACTOR_CHANGES: Record<string, AuditEventType> = {
	"/two-factor/verify-totp": "two_factor_enabled",
	"/two-factor/disable": "two_factor_disabled",
};

/** Whether a right password still leaves this person a code to enter. */
async function owesACode(db: Database, userId: string): Promise<boolean> {
	const user = await db
		.select({ twoFactorEnabled: schema.user.twoFactorEnabled })
		.from(schema.user)
		.where(eq(schema.user.id, userId))
		.get();
	return user?.twoFactorEnabled === true;
}

/** For Better Auth's `databaseHooks`: what happens to a row, however a request came to do it. */
export function auditDatabaseHooks(db: Database, record: RecordEvent) {
	return {
		user: {
			afterCreate: async (user: { id: string }, context: GenericEndpointContext | null) => {
				record("account_created", {
					userId: user.id,
					detail: signInMethod(context),
					...whereFrom(context?.headers),
				});
			},
			afterUpdate: async (user: { id: string }, context: GenericEndpointContext | null) => {
				const type = context && TWO_FACTOR_CHANGES[context.path];
				if (type) record(type, { userId: user.id, ...whereFrom(context.headers) });
			},
		},
		account: {
			afterCreate: async (
				account: { userId: string; providerId: string },
				context: GenericEndpointContext | null,
			) => {
				// A password is one way in that has its own events.
				if (account.providerId === "credential") return;
				record("provider_linked", {
					userId: account.userId,
					detail: account.providerId,
					...whereFrom(context?.headers),
				});
			},
			afterDelete: async (
				account: { userId: string; providerId: string },
				context: GenericEndpointContext | null,
			) => {
				// The request names only the row, so what it was can be read from nothing else.
				const password = account.providerId === "credential";
				record(password ? "password_changed" : "provider_unlinked", {
					userId: account.userId,
					detail: password ? "removed" : account.providerId,
					...whereFrom(context?.headers),
				});
			},
		},
		session: {
			afterCreate: async (
				session: { userId: string; ipAddress?: string | null; userAgent?: string | null },
				context: GenericEndpointContext | null,
			) => {
				const method = signInMethod(context);
				if (!method) return;
				// The plugin takes this session away again when a code is owed. A password alone has not
				// signed anyone in, though someone who did not enter it will want to know it was right.
				const asked = method === "password" && (await owesACode(db, session.userId));
				record(asked ? "two_factor_asked" : "sign_in", {
					userId: session.userId,
					detail: method,
					ip: session.ipAddress ?? null,
					device: session.userAgent ? describeDevice(session.userAgent) : null,
				});
			},
		},
	};
}

/** What a request with a session did, for the paths that say so by succeeding. */
const ACCOUNT_EVENTS: Record<string, { type: AuditEventType; detail?: string }> = {
	"/change-password": { type: "password_changed", detail: "changed" },
	"/account/first-password": { type: "password_changed", detail: "first" },
	"/passkey/verify-registration": { type: "passkey_added" },
	"/account/remove-passkey": { type: "passkey_removed" },
	"/two-factor/generate-backup-codes": { type: "recovery_codes_replaced" },
	"/revoke-session": { type: "sessions_revoked" },
	"/revoke-sessions": { type: "sessions_revoked" },
	"/revoke-other-sessions": { type: "sessions_revoked" },
};

/** The address someone typed names an account or nothing, and only the account is kept. */
function ownerOfAddress(db: Database, body: Record<string, unknown> | undefined) {
	const email = body?.email;
	if (typeof email !== "string") return undefined;
	return db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, email.toLowerCase()))
		.get();
}

function ownerOfPasskey(db: Database, body: Record<string, unknown> | undefined) {
	const response = body?.response;
	const credentialID = (response as { id?: unknown } | null | undefined)?.id;
	if (typeof credentialID !== "string") return undefined;
	return db
		.select({ id: schema.passkey.userId })
		.from(schema.passkey)
		.where(eq(schema.passkey.credentialID, credentialID))
		.get();
}

/**
 * Who a sign-in waiting for a code belongs to. The cookie only says which challenge it is, and the
 * challenge says who. Nobody has one who has not given that person's password.
 */
export async function ownerOfChallenge(
	ctx: Pick<GenericEndpointContext, "context" | "getSignedCookie">,
): Promise<{ id: string } | undefined> {
	const { name } = ctx.context.createAuthCookie("two_factor");
	const challenge = await ctx.getSignedCookie(name, ctx.context.secret);
	if (!challenge) return undefined;
	const row = await ctx.context.internalAdapter.findVerificationValue(challenge);
	return row ? { id: row.value } : undefined;
}

/** What each way of signing in calls itself when it fails, and who it was against. */
const FAILED_SIGN_INS: Record<
	string,
	{
		detail: string;
		owner: (db: Database, ctx: GenericEndpointContext) => Promise<{ id: string } | undefined>;
	}
> = {
	"/sign-in/email": { detail: "password", owner: async (db, ctx) => ownerOfAddress(db, ctx.body) },
	"/passkey/verify-authentication": {
		detail: "passkey",
		owner: async (db, ctx) => {
			const owner = await ownerOfPasskey(db, ctx.body);
			return owner ?? undefined;
		},
	},
	// Someone with a session mistyping as they set this up has no challenge, and writes nothing.
	"/two-factor/verify-totp": { detail: "totp", owner: (_db, ctx) => ownerOfChallenge(ctx) },
	"/two-factor/verify-backup-code": {
		detail: "recovery_code",
		owner: (_db, ctx) => ownerOfChallenge(ctx),
	},
};

/** The most a person is shown: enough to spot what was not them. */
const ACTIVITY_LIMIT = 50;

/** Names the apps in these events, for the ones that still exist. */
async function appNames(db: Database, apps: string[]): Promise<Map<string, string>> {
	if (apps.length === 0) return new Map();
	// One client's unreadable metadata, which `json_extract` alone throws on, must not take this page
	// from everybody. It gets no name here, as it gets nobody in the check for who may sign in.
	const { metadata } = schema.oauthClient;
	const appId = sql<string>`case when json_valid(${metadata}) then json_extract(${metadata}, '$.app') end`;
	const rows = await db
		.select({ app: appId, name: schema.oauthClient.name })
		.from(schema.oauthClient)
		.where(inArray(appId, apps))
		.all();
	return new Map(rows.flatMap(({ app, name }) => (name ? [[app, name] as const] : [])));
}

/**
 * Records what happens at paths that have no row to hook, and shows a person their own events. A
 * workspace's admins will see that workspace's events through their own endpoint, when there are
 * workspaces.
 */
export function auditLog(db: Database, record: RecordEvent): BetterAuthPlugin {
	return {
		id: "audit-log",
		endpoints: {
			accountActivity: createAuthEndpoint(
				"/account/activity",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
						ctx.setHeader(name, value);
					}
					const events = await db
						.select()
						.from(schema.auditEvent)
						.where(eq(schema.auditEvent.userId, ctx.context.session.user.id))
						.orderBy(desc(schema.auditEvent.at))
						.limit(ACTIVITY_LIMIT)
						.all();
					const names = await appNames(db, [
						...new Set(events.flatMap(({ app }) => (app ? [app] : []))),
					]);
					return {
						events: events.map(
							({ id, at, type, app, ip, device, detail }): AuditActivity => ({
								id,
								at,
								type,
								app: app && (names.get(app) ?? app),
								ip,
								device,
								detail,
							}),
						),
					};
				},
			),
		},
		hooks: {
			after: [
				{
					matcher: ({ path = "" }) => path in FAILED_SIGN_INS || path in ACCOUNT_EVENTS,
					handler: createAuthMiddleware(async (ctx) => {
						const failed = isAPIError(ctx.context.returned);
						const from = whereFrom(ctx.headers);

						const signIn = FAILED_SIGN_INS[ctx.path];
						if (signIn) {
							if (!failed) return;
							// Someone trying addresses leaves no rows: the rate limit bounds what can reach here
							// for an account, and nothing bounds the addresses that have none.
							record("sign_in_failed", async () => {
								const owner = await signIn.owner(db, ctx);
								return owner && { userId: owner.id, detail: signIn.detail, ...from };
							});
							return;
						}

						const event = ACCOUNT_EVENTS[ctx.path];
						if (failed || !event) return;
						const session = await getSessionFromCtx(ctx);
						if (!session) return;
						record(event.type, {
							userId: session.user.id,
							detail: event.detail,
							...from,
						});
					}),
				},
			],
		},
	};
}
