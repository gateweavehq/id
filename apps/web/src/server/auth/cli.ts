// Entry point for `pnpm auth:schema` only. The Better Auth CLI reads the configuration to
// generate the Drizzle schema; it never connects to a database. So the database is made here as
// Drizzle makes it: `createDb` wants a D1 binding to watch, and refuses a stand-in that has none.
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { createAuth } from "./config";

export const auth = createAuth({
	db: drizzle({} as D1Database, { schema }),
	secret: "schema-generation-only",
	baseURL: "http://localhost:4730",
	oidc: {
		issuer: "http://localhost:4730",
		pairwiseSecret: "schema-generation-only-schema-generation-only",
	},
});
