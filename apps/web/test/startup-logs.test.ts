import { afterAll, beforeAll, expect, it } from "vitest";
import { startId } from "./id-worker";

// workerd forbids I/O in global scope. Better Auth starts resolving its context as soon as it is
// created, so building it at module load can log an error on every cold start that hides real
// ones. The app builds it on first use instead.

const origin = "https://id.test";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

it("starts and serves requests without logging an error", async () => {
	await id.fetch(`${origin}/login`);
	const session = await id.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
	expect(session.status).toBe(200);

	expect(id.logs.filter((log) => log.level === "error")).toEqual([]);
});
