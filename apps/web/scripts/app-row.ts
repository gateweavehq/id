import { createHash, randomBytes } from "node:crypto";

/** What a deployment says about an app it registers. */
export interface NewApp {
	/** The app's own id, such as `track`, which the check for who may sign in goes by. */
	app: string;
	name: string;
	redirectUris: string[];
	postLogoutRedirectUris?: string[] | undefined;
	backchannelLogoutUri?: string | undefined;
}

/**
 * The provider's `prefix.clientSecret`. It is part of the secret an app holds, and not of what is
 * hashed, so that a secret found in a log says what it is.
 */
export const CLIENT_SECRET_PREFIX = "gwid_cs_";

/**
 * Registers without Better Auth, whose function for it can only run inside the Worker and which no
 * route may offer. So this has to write what the provider would. `test/oidc.test.ts` signs in with
 * a row built here, which fails when an upgrade changes what the provider reads.
 */
export function appRow(app: NewApp, now = new Date()) {
	const clientId = randomBytes(24).toString("base64url");
	const secret = randomBytes(32).toString("base64url");
	const row = {
		id: randomBytes(16).toString("hex"),
		client_id: clientId,
		// The provider compares this with the SHA-256 of what an app sends, without the prefix.
		client_secret: createHash("sha256").update(secret).digest("base64url"),
		disabled: 0,
		// First-party apps do not ask. An app a workspace adds always does (see the architecture notes).
		skip_consent: 1,
		enable_end_session: 1,
		subject_type: "pairwise",
		scopes: JSON.stringify(["openid", "profile", "email", "offline_access"]),
		created_at: now.getTime(),
		updated_at: now.getTime(),
		name: app.name,
		redirect_uris: JSON.stringify(app.redirectUris),
		post_logout_redirect_uris: app.postLogoutRedirectUris
			? JSON.stringify(app.postLogoutRedirectUris)
			: null,
		backchannel_logout_uri: app.backchannelLogoutUri ?? null,
		backchannel_logout_session_required: app.backchannelLogoutUri ? 1 : 0,
		token_endpoint_auth_method: "client_secret_basic",
		application_type: "web",
		grant_types: JSON.stringify(["authorization_code", "refresh_token"]),
		response_types: JSON.stringify(["code"]),
		require_pkce: 1,
		metadata: JSON.stringify({ app: app.app }),
	};
	return { row, clientId, clientSecret: `${CLIENT_SECRET_PREFIX}${secret}` };
}

export function sqlValue(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replaceAll("'", "''")}'`;
}

/** The statement that adds a row. Its values come from whoever runs the script, on their database. */
export function insertStatement(row: ReturnType<typeof appRow>["row"]): string {
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
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		return `${value} must use https`;
	}
	return undefined;
}
