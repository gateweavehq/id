import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database, schema } from "../db";
import { faulty, migratedD1 } from "../db/faulty-d1";
import { waysToSignIn } from "./ways-to-sign-in";

let real: Awaited<ReturnType<typeof migratedD1>>;
let db: Database;

const now = new Date();

async function person(id: string) {
	await db
		.insert(schema.user)
		.values({ id, name: id, email: `${id}@ways.test`, emailVerified: true })
		.run();
	return { user: { id } };
}

function account(userId: string, providerId: string) {
	return db
		.insert(schema.account)
		.values({
			id: `${userId}-${providerId}`,
			accountId: userId,
			providerId,
			userId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function passkey(userId: string, name: string) {
	return db
		.insert(schema.passkey)
		.values({
			id: `${userId}-${name}`,
			name,
			publicKey: "not-a-key",
			userId,
			credentialID: `${userId}-${name}`,
			counter: 0,
			deviceType: "singleDevice",
			backedUp: false,
		})
		.run();
}

beforeAll(async () => {
	real = await migratedD1("ways-to-sign-in-test");
	// A new server takes one account and closes, and these tests make several.
	await real.d1.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
	db = createDb(real.d1);
});

afterAll(async () => {
	await real?.dispose();
});

describe("waysToSignIn", () => {
	it("says what one person has, and nothing of anyone else's", async () => {
		const ada = await person("ada");
		const grace = await person("grace");
		await account("ada", "credential");
		await account("ada", "github");
		await passkey("ada", "laptop");
		await passkey("ada", "key");
		await account("grace", "github");

		expect(await waysToSignIn(db, ada, true)).toEqual({
			password: true,
			github: true,
			passkeys: 2,
		});
		expect(await waysToSignIn(db, grace, true)).toEqual({
			password: false,
			github: true,
			passkeys: 0,
		});
	});

	it("does not count GitHub on a server that does not sign people in with it", async () => {
		const linus = await person("linus");
		await account("linus", "github");
		expect(await waysToSignIn(db, linus, false)).toEqual({
			password: false,
			github: false,
			passkeys: 0,
		});
	});

	// It used to read the session a second time for the passkeys, and answer "none" when that read
	// came back empty.
	it("fails as a whole without a session, rather than say there are no passkeys", async () => {
		await expect(waysToSignIn(db, null, true)).rejects.toThrow();
	});

	it("fails as a whole when either read fails, rather than answer with half", async () => {
		const edsger = await person("edsger");
		await account("edsger", "credential");
		await passkey("edsger", "phone");
		const { database, state } = faulty(real.d1);
		state.failures = 10;
		state.only = /passkey/;
		await expect(waysToSignIn(createDb(database), edsger, true)).rejects.toThrow();
		state.failures = 0;
		expect(await waysToSignIn(createDb(database), edsger, true)).toEqual({
			password: true,
			github: false,
			passkeys: 1,
		});
	});
});
