import { drizzle } from "drizzle-orm/d1";
import { withoutStatements } from "./query-failure";
import { retryingReads } from "./retry-reads";
import * as schema from "./schema";

/**
 * The database every part of the Worker asks: Better Auth and its plugins, the provider's hooks,
 * the pages' server functions, the consumer of the `LOGOUTS` queue and both cron runs. A read that
 * fails for a moment is sent again (`retry-reads.ts`), and a query that failed for good is thrown
 * without its statement or its values (`query-failure.ts`).
 */
export function createDb(d1: D1Database) {
	const db = drizzle(retryingReads(d1), { schema });
	// A deployment without a database serves nothing (`notSetUp` in server.ts), and has to start
	// to say so: there is no query to fail, and no binding for `withoutStatements` to find.
	return d1 ? withoutStatements(db) : db;
}

export type Database = ReturnType<typeof createDb>;
export { schema };
