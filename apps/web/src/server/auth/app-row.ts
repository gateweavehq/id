import { createHash, randomBytes } from "node:crypto";

/**
 * How an app can send its secret to the token endpoint. Libraries differ and some offer no choice, so an
 * app says which, and the provider then takes only that one. `none` is not here, since every app has a
 * secret, and nothing can be registered for a signed assertion.
 */
export const CLIENT_AUTH_METHODS = ["client_secret_basic", "client_secret_post"] as const;
export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

/** What an app's library can do. With nothing said, it uses HTTP Basic and PKCE. */
export interface AppLibrary {
	clientAuth?: ClientAuthMethod | undefined;
	/**
	 * False lets it leave PKCE out, for a library that cannot do it. The app then has to send a nonce and
	 * check it, because nothing else stops a code that goes astray. RFC 9700 allows that of an app with a
	 * secret, and the provider still wants one or the other for `offline_access`.
	 */
	requirePkce?: boolean | undefined;
}

/** What a deployment says about an app it registers. */
export interface NewApp extends AppLibrary {
	/** The app's own id, such as `track`, which the check for who may sign in goes by. */
	app: string;
	name: string;
	redirectUris: string[];
	postLogoutRedirectUris?: string[] | undefined;
	backchannelLogoutUri?: string | undefined;
}

/** What a workspace's admin says about an app. Everything else about it is decided here. */
export interface NewWorkspaceApp extends AppLibrary {
	workspace: string;
	name: string;
	redirectUris: string[];
	/** The user id of the admin adding it, which the app list shows once they have left. */
	addedBy: string;
}

/**
 * The provider's `prefix.clientSecret`. It is part of the secret an app holds, and not of what is
 * hashed, so that a secret found in a log says what it is.
 */
export const CLIENT_SECRET_PREFIX = "gwid_cs_";

/** A new secret, and what the provider keeps of it: the SHA-256 of what an app sends, unprefixed. */
export function newClientSecret() {
	const secret = randomBytes(32).toString("base64url");
	return {
		clientSecret: `${CLIENT_SECRET_PREFIX}${secret}`,
		hashed: createHash("sha256").update(secret).digest("base64url"),
	};
}

function newClientId(): string {
	return randomBytes(24).toString("base64url");
}

const FIRST_PARTY_SCOPES = ["openid", "profile", "email", "offline_access"];
/** A group belongs to a workspace, so an app that belongs to none has nothing to ask about. */
const WORKSPACE_APP_SCOPES = [...FIRST_PARTY_SCOPES, "groups"];

function baseRow(
	clientId: string,
	hashedSecret: string,
	app: AppLibrary & { name: string; redirectUris: string[] },
	scopes: string[],
	now: Date,
) {
	return {
		id: randomBytes(16).toString("hex"),
		client_id: clientId,
		client_secret: hashedSecret,
		disabled: 0,
		subject_type: "pairwise",
		scopes: JSON.stringify(scopes),
		created_at: now.getTime(),
		updated_at: now.getTime(),
		name: app.name,
		redirect_uris: JSON.stringify(app.redirectUris),
		token_endpoint_auth_method: app.clientAuth ?? "client_secret_basic",
		application_type: "web",
		grant_types: JSON.stringify(["authorization_code", "refresh_token"]),
		response_types: JSON.stringify(["code"]),
		require_pkce: app.requirePkce === false ? 0 : 1,
	};
}

/**
 * Registers without Better Auth, whose function for it can only run inside the Worker and which no
 * route may offer. So this has to write what the provider would. `test/oidc.test.ts` signs in with
 * a row built here, which fails when an upgrade changes what the provider reads.
 */
export function appRow(app: NewApp, now = new Date()) {
	const clientId = newClientId();
	const { clientSecret, hashed } = newClientSecret();
	const row = {
		...baseRow(clientId, hashed, app, FIRST_PARTY_SCOPES, now),
		// First-party apps do not ask. An app a workspace adds always does.
		skip_consent: 1,
		enable_end_session: 1,
		post_logout_redirect_uris: app.postLogoutRedirectUris
			? JSON.stringify(app.postLogoutRedirectUris)
			: null,
		backchannel_logout_uri: app.backchannelLogoutUri ?? null,
		backchannel_logout_session_required: app.backchannelLogoutUri ? 1 : 0,
		reference_id: null,
		metadata: JSON.stringify({ app: app.app }),
	};
	return { row, clientId, clientSecret };
}

/**
 * An app a workspace adds. Only the server writes these values, so the check for who may sign in can
 * trust `metadata`, and nobody can ask for anything here to be otherwise. `reference_id` is what finds
 * a workspace's apps, and `metadata.workspace` is what the token hooks can see of the same fact.
 */
export function workspaceAppRow(app: NewWorkspaceApp, now = new Date()) {
	const clientId = newClientId();
	const { clientSecret, hashed } = newClientSecret();
	const row = {
		...baseRow(clientId, hashed, app, WORKSPACE_APP_SCOPES, now),
		// Otherwise any workspace's admin could receive a member's address without them being asked.
		skip_consent: 0,
		// With neither of these, the provider emits no `sid`, which two apps that do not trust each
		// other could use to match one person up across a session.
		enable_end_session: 0,
		post_logout_redirect_uris: null,
		backchannel_logout_uri: null,
		backchannel_logout_session_required: 0,
		reference_id: app.workspace,
		metadata: JSON.stringify({ app: clientId, workspace: app.workspace }),
		added_by: app.addedBy,
	};
	return { row, clientId, clientSecret };
}

type Row = ReturnType<typeof appRow>["row"] | ReturnType<typeof workspaceAppRow>["row"];

export function sqlValue(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}

/** The statement that adds a row. Its values come from whoever runs the script, on their database. */
export function insertStatement(row: Row): string {
	const entries = Object.entries(row);
	const columns = entries.map(([column]) => `"${column}"`).join(", ");
	const values = entries.map(([, value]) => sqlValue(value)).join(", ");
	return `INSERT INTO "oauth_client" (${columns}) VALUES (${values});`;
}

/** The audit log's line about this. Whoever runs the script is known to Cloudflare, not to ID. */
export function appAddedStatement(app: string): string {
	const values = [crypto.randomUUID(), Date.now(), "app_added", app].map(sqlValue).join(", ");
	return `INSERT INTO "audit_event" ("id", "at", "type", "app") VALUES (${values});`;
}

/**
 * What an app may name as where to send someone back. An exact https URL, or plain http only on this
 * machine. A code sent elsewhere signs in whoever receives it.
 */
export function problemWithRedirectUri(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return `${value} is not a URL`;
	}
	if (url.hash) return `${value} has a fragment`;
	if (url.username || url.password) return `${value} holds a name or a password`;
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		return `${value} must use https`;
	}
	return undefined;
}

/**
 * What a workspace's admin may name, beyond what any app may. They choose these values, and the people
 * they reach did not, so a code must never come back here to be read by whatever this host serves.
 * One host, because an app's subjects are computed from it (see `docs/architecture.md`).
 */
export function problemWithWorkspaceAppUris(uris: string[], issuer: string): string | undefined {
	for (const uri of uris) {
		const problem = problemWithRedirectUri(uri);
		if (problem) return problem;
	}
	if (new Set(uris.map((uri) => new URL(uri).host)).size > 1) {
		return "All of an app's redirect URIs must be on one host.";
	}
	const own = new URL(issuer);
	for (const uri of uris) {
		const url = new URL(uri);
		// The same host to a browser, and not to anything here that compares it with another.
		if (url.hostname.endsWith(".")) return `${uri} has a host that ends in a dot`;
		// Other ports of this machine are other programs. Other ports of a real host are not to be trusted.
		const local = own.hostname === "localhost" || own.hostname === "127.0.0.1";
		if (local ? url.host === own.host : url.hostname === own.hostname) {
			return "An app cannot send people back to this server.";
		}
	}
	return undefined;
}

/** The host an app's redirect URIs share, which is what people are told an app returns to. */
export function hostOfUris(uris: unknown): string | null {
	const first = Array.isArray(uris) ? uris[0] : undefined;
	return typeof first === "string" && URL.canParse(first) ? new URL(first).host : null;
}
