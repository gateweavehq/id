// What the OpenID Foundation's conformance suite says of ID, test by test, and why. A run fails on any
// difference, a better result included, so that this stays true. It runs under Node without a build,
// so this file has to stay plain enough for Node to read as it is. See docs/conformance.md.

export type Result = "PASSED" | "WARNING" | "REVIEW" | "SKIPPED" | "FAILED";
export type Kind = "first-party" | "workspace";

interface Expected {
	result: Result;
	why: string;
	/**
	 * For a test the suite leaves to a person to look at: the page of ID that has to have been shown. In
	 * a job nobody looks at a picture, so without this any page would do.
	 */
	shows?: string;
}

/** Every test of the Basic OP plan that does not plainly pass, for first-party apps. */
const BASIC: Record<string, Expected> = {
	"oidcc-scope-profile": {
		result: "WARNING",
		why: "Not every standard profile claim: ID holds a name and a picture, and nothing more.",
	},
	"oidcc-scope-email": {
		result: "WARNING",
		why: "The ID token holds the address too, because Cloudflare Access reads only that.",
	},
	"oidcc-alternate-happy-flow": {
		result: "WARNING",
		why: "The same address in the ID token, on another way through the same flow.",
	},
	"oidcc-claims-essential": {
		result: "WARNING",
		why: "The `claims` parameter is dropped from every request, and discovery says so.",
	},
	"oidcc-scope-address": { result: "SKIPPED", why: "ID holds no postal address." },
	"oidcc-scope-phone": { result: "SKIPPED", why: "ID holds no phone number." },
	"oidcc-scope-all": { result: "SKIPPED", why: "No address or phone scope to ask for." },
	"oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported": {
		result: "SKIPPED",
		why: "Request objects are refused with request_not_supported, as discovery says.",
	},
	"oidcc-prompt-login": {
		result: "REVIEW",
		why: "The suite wants a picture of the second login.",
		shows: "/login",
	},
	"oidcc-max-age-1": {
		result: "REVIEW",
		why: "The suite wants a picture of the second login.",
		shows: "/login",
	},
	"oidcc-ensure-registered-redirect-uri": {
		result: "REVIEW",
		why: "The suite wants a picture of the page that refuses it.",
		shows: "/request-refused",
	},
	"oidcc-ensure-request-object-with-redirect-uri": {
		result: "REVIEW",
		why: "The suite wants a picture of the page that refuses it.",
		shows: "/request-refused",
	},
};

/**
 * Apps a workspace adds differ in one test, on purpose. Anyone can add an app, so answering a person
 * nobody has signed in with a quiet redirect to it would make ID an open redirector (RFC 9700,
 * section 4.11.2). They get the sign-in page instead. See `membersOnlyToWorkspaceApps`.
 */
const WORKSPACE_APPS: Record<string, Expected> = {
	...BASIC,
	"oidcc-prompt-none-not-logged-in": {
		result: "FAILED",
		why: "Deliberate: the sign-in page rather than a redirect to an app anyone can add.",
		shows: "/login",
	},
};

function tableFor(kind: Kind) {
	return kind === "workspace" ? WORKSPACE_APPS : BASIC;
}

/** What the suite should say of a test. Whatever is not named should pass. */
export function expectedOf(kind: Kind, test: string): Expected {
	return tableFor(kind)[test] ?? { result: "PASSED", why: "" };
}

/** The tests named here, to notice one that a new version of the suite has dropped. */
export function namedTests(kind: Kind): string[] {
	return Object.keys(tableFor(kind));
}
