// What `server.mjs` puts in the database before the tests start, and the tests rely on. It runs under
// Node without a build, so this file has to stay plain enough for Node to read as it is.

/**
 * The app the tests play. `server.mjs` answers at this address, because `page.route` does not see where
 * a redirect leads, and the tests do what the app's server would.
 */
export const APP = {
	name: "Browser Test App",
	port: 4733,
	redirectUri: "http://localhost:4733/callback",
};

/** Someone who already has an account, so that a test about something else need not make one. */
export const PERSON = {
	name: "Seeded Person",
	email: "seeded-person@example.com",
	password: "a-long-password-for-browser-tests",
};
