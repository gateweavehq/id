import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitHubCode, type SentEmail, startId } from "./id-worker";

// Workspaces, through the public routes of the built Worker. Every rule is tried by someone it should
// stop as well as someone it should let through, because a rule nobody is refused by proves nothing.

const origin = "https://id.test";
const PASSWORD = "a-long-password-for-tests";
const CHROME_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let id: Awaited<ReturnType<typeof startId>>;

beforeAll(async () => {
	id = await startId(origin);
});

afterAll(async () => {
	await id?.dispose();
});

let clients = 0;

/** Each request can come from an address of its own, so rate limits stay out of the way. */
function newClient() {
	const n = ++clients;
	return `198.51.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

interface Who {
	cookie: string;
	client?: string;
}

function api(
	path: string,
	init: { who?: Who; body?: object; userAgent?: string; client?: string; worker?: typeof id } = {},
) {
	const { who, body, userAgent, client, worker = id } = init;
	return worker.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": client ?? who?.client ?? newClient(),
			...(body && { "content-type": "application/json" }),
			...(who && { cookie: who.cookie }),
			...(userAgent && { "user-agent": userAgent }),
		},
		body: body && JSON.stringify(body),
	});
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function emailTo(address: string, like: RegExp): Promise<SentEmail> {
	return vi.waitFor(
		async () => {
			const sent = (await id.emails()).filter((message) => message.to === address);
			const found = sent.findLast((message) => like.test(message.text));
			if (!found) throw new Error(`Nothing like ${like} reached ${address}`);
			return found;
		},
		{ timeout: 5_000 },
	);
}

let people = 0;

function newAddress() {
	return `workspace-person-${++people}@example.com`;
}

/** A new person, signed in. */
async function newPerson(name = "Ada", email = newAddress()) {
	const client = newClient();
	await api("/email-otp/send-verification-otp", { client, body: { email, type: "sign-in" } });
	const { text } = await emailTo(email, /\b\d{6}\b/);
	const otp = /\b\d{6}\b/.exec(text)?.[0];
	const entered = await api("/sign-in/email-otp", { client, body: { email, otp, name } });
	expect(entered.status).toBe(200);
	const cookie = cookieOf(entered);
	const set = await api("/account/first-password", {
		client,
		who: { cookie },
		body: { newPassword: PASSWORD },
	});
	expect(set.status).toBe(200);
	const session = (await (await api("/get-session", { client, who: { cookie } })).json()) as {
		user: { id: string };
	};
	return { email, name, client, cookie, userId: session.user.id };
}

type Person = Awaited<ReturnType<typeof newPerson>>;

let slugs = 0;

async function newWorkspace(owner: Person, name = "Acme") {
	const slug = `workspace-${++slugs}`;
	const response = await api("/organization/create", {
		who: owner,
		client: newClient(),
		body: { name, slug },
	});
	expect(response.status).toBe(200);
	const { id: workspaceId } = (await response.json()) as { id: string };
	return { id: workspaceId, slug, name };
}

type Workspace = Awaited<ReturnType<typeof newWorkspace>>;

interface Details {
	workspace: { id: string; name: string; slug: string };
	you: { memberId: string; role: string };
	members: { id: string; name: string; email: string; role: string }[];
	invitations: { id: string; email: string; role: string }[];
}

async function details(who: Who, workspace: Workspace): Promise<Details> {
	const response = await api(`/workspaces/get?slug=${workspace.slug}`, { who });
	expect(response.status).toBe(200);
	return (await response.json()) as Details;
}

async function invite(by: Who, workspace: Workspace, email: string, role = "member") {
	const response = await api("/organization/invite-member", {
		who: by,
		client: newClient(),
		body: { organizationId: workspace.id, email, role },
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

/** Brings someone in, by the invitation that a real member would get. */
async function join(person: Person, workspace: Workspace, by: Who, role = "member") {
	const invitationId = await invite(by, workspace, person.email, role);
	const accepted = await api("/organization/accept-invitation", {
		who: person,
		client: newClient(),
		body: { invitationId },
	});
	expect(accepted.status).toBe(200);
	const { you } = await details(person, workspace);
	return you.memberId;
}

function statusOfInvitation(invitationId: string) {
	return id.db
		.prepare("SELECT status FROM invitation WHERE id = ?")
		.bind(invitationId)
		.first<string>("status");
}

function count(table: string, column: string, value: string) {
	return id.db
		.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
		.bind(value)
		.first<number>("n");
}

describe("what can be reached", () => {
	it.each([
		["GET", "/organization/list"],
		["GET", "/organization/get-full-organization"],
		["GET", "/organization/get-organization"],
		["GET", "/organization/list-members"],
		["GET", "/organization/list-invitations"],
		["GET", "/organization/list-user-invitations"],
		["GET", "/organization/get-invitation"],
		["GET", "/organization/get-active-member"],
		["GET", "/organization/get-active-member-role"],
		["POST", "/organization/set-active"],
		["POST", "/organization/check-slug"],
		["POST", "/organization/has-permission"],
		["POST", "/organization/create-team"],
		["POST", "/organization/create-role"],
	])("closes %s %s, even to someone signed in", async (method, path) => {
		const person = await newPerson();
		const response = await api(path, {
			who: person,
			...(method === "POST" && { body: {} }),
		});
		expect(response.status).toBe(404);
	});

	it.each([
		"/organization/create",
		"/organization/update",
		"/organization/delete",
		"/organization/leave",
		"/organization/invite-member",
		"/organization/cancel-invitation",
		"/organization/accept-invitation",
		"/organization/reject-invitation",
		"/organization/remove-member",
		"/organization/update-member-role",
	])("wants someone signed in at %s", async (path) => {
		expect((await api(path, { body: {} })).status).toBe(401);
	});

	it.each(["/workspaces/list", "/workspaces/get?slug=x", "/workspaces/invitation?id=x"])(
		"wants someone signed in at %s",
		async (path) => {
			expect((await api(path)).status).toBe(401);
		},
	);

	it("lets nothing on the way keep what it reads", async () => {
		const [owner, invited] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(owner);
		const invitationId = await invite(owner, workspace, invited.email);
		const reads: [Person, string][] = [
			[owner, "/workspaces/list"],
			[owner, `/workspaces/get?slug=${workspace.slug}`],
			[invited, `/workspaces/invitation?id=${invitationId}`],
		];
		for (const [who, path] of reads) {
			const response = await api(path, { who });
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toContain("no-store");
		}
	});

	it("refuses a request from another site", async () => {
		const person = await newPerson();
		const response = await id.fetch(`${origin}/api/auth/organization/create`, {
			method: "POST",
			headers: {
				origin: "https://sandbox.gateweave.test",
				"cf-connecting-ip": newClient(),
				"content-type": "application/json",
				cookie: person.cookie,
			},
			body: JSON.stringify({ name: "Elsewhere", slug: "elsewhere" }),
		});
		expect(response.status).toBe(403);
		expect(await count("organization", "slug", "elsewhere")).toBe(0);
	});
});

describe("making a workspace", () => {
	it("is not for an account whose address is not proven", async () => {
		const person = await newPerson();
		await id.db
			.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
			.bind(person.userId)
			.run();
		const slug = `unproven-${++slugs}`;
		const made = await api("/organization/create", {
			who: person,
			body: { name: "Unproven", slug },
		});
		expect(made.status).toBe(403);
		expect(await count("organization", "slug", slug)).toBe(0);
	});

	it("lists only the workspaces someone is in", async () => {
		const [mine, theirs] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(mine);
		await newWorkspace(theirs);
		const list = (await (await api("/workspaces/list", { who: mine })).json()) as {
			workspaces: { id: string }[];
		};
		expect(list.workspaces.map((entry) => entry.id)).toEqual([workspace.id]);
	});

	it("makes the person who asks its owner", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner, "Çay & Kahve");
		const { you, members, workspace: seen } = await details(owner, workspace);
		expect(you.role).toBe("owner");
		expect(seen).toEqual({ id: workspace.id, name: "Çay & Kahve", slug: workspace.slug });
		expect(members).toEqual([
			{ id: you.memberId, name: owner.name, email: owner.email, role: "owner" },
		]);

		const list = (await (await api("/workspaces/list", { who: owner })).json()) as {
			workspaces: unknown[];
		};
		expect(list.workspaces).toEqual([
			{ id: workspace.id, name: "Çay & Kahve", slug: workspace.slug, role: "owner" },
		]);
	});

	it.each([
		["a logo, which any page could then load", { logo: "https://evil.test/track.png" }],
		["metadata, which apps' checks read", { metadata: { app: "track" } }],
		["another person as its owner", { userId: "someone-else" }],
		["something nothing here knows", { keepCurrentActiveOrganization: true }],
	])("refuses %s", async (_case, extra) => {
		const person = await newPerson();
		const slug = `extra-${++slugs}`;
		const response = await api("/organization/create", {
			who: person,
			body: { name: "Acme", slug, ...extra },
		});
		expect(response.status).toBe(400);
		expect(await count("organization", "slug", slug)).toBe(0);
	});

	it.each([
		["a name with a link", { name: "See https://evil.test", slug: "bad-name-1" }],
		["a name that hides something", { name: "Ac​me", slug: "bad-name-2" }],
		["a name of nothing", { name: "", slug: "bad-name-3" }],
		["a long name", { name: "x".repeat(61), slug: "bad-name-4" }],
		["an address with capitals", { name: "Acme", slug: "Bad-Slug" }],
		["an address with a path in it", { name: "Acme", slug: "../account" }],
	])("refuses %s", async (_case, body) => {
		const person = await newPerson();
		const response = await api("/organization/create", { who: person, body });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("INVALID_REQUEST");
		expect(await count("organization", "slug", body.slug)).toBe(0);
	});

	it("refuses an address that is taken", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const response = await api("/organization/create", {
			who: second,
			body: { name: "Copy", slug: workspace.slug },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("ORGANIZATION_ALREADY_EXISTS");
		expect((await details(first, workspace)).workspace.name).toBe("Acme");
	});

	it("stops at the limit of what one person can own, and counts nothing else", async () => {
		const hoarder = await newPerson();
		for (let made = 0; made < 9; made++) await newWorkspace(hoarder);

		// Being invited to a workspace is someone else's choice, and must not use this up.
		for (let joined = 0; joined < 3; joined++) {
			const owner = await newPerson();
			await join(hoarder, await newWorkspace(owner), owner);
		}
		await newWorkspace(hoarder);

		const refused = await api("/organization/create", {
			who: hoarder,
			client: newClient(),
			body: { name: "One more", slug: `one-more-${++slugs}` },
		});
		expect(refused.status).toBe(403);
	});
});

describe("who may do what", () => {
	let owner: Person;
	let admin: Person;
	let plain: Person;
	let target: Person;
	let stranger: Person;
	let otherAdmin: Person;
	let workspace: Workspace;
	let targetMember: string;
	let openInvitation: string;

	beforeAll(async () => {
		[owner, admin, plain, target, stranger, otherAdmin] = await Promise.all([
			newPerson("Owner"),
			newPerson("Admin"),
			newPerson("Plain"),
			newPerson("Target"),
			newPerson("Stranger"),
			newPerson("Other admin"),
		]);
		workspace = await newWorkspace(owner, "Guarded");
		await join(admin, workspace, owner, "admin");
		await join(plain, workspace, owner, "member");
		targetMember = await join(target, workspace, owner, "member");
		await newWorkspace(otherAdmin, "Theirs");
		openInvitation = await invite(owner, workspace, newAddress());
	});

	const forbiddenToOutsiders = (): [string, object][] => [
		["/organization/update", { organizationId: workspace.id, data: { name: "Taken" } }],
		["/organization/delete", { organizationId: workspace.id }],
		["/organization/leave", { organizationId: workspace.id }],
		[
			"/organization/invite-member",
			{ organizationId: workspace.id, email: newAddress(), role: "admin" },
		],
		["/organization/cancel-invitation", { invitationId: openInvitation }],
		[
			"/organization/remove-member",
			{ organizationId: workspace.id, memberIdOrEmail: targetMember },
		],
		[
			"/organization/update-member-role",
			{ organizationId: workspace.id, memberId: targetMember, role: "admin" },
		],
	];

	const forbiddenToMembers = (): [string, object][] =>
		forbiddenToOutsiders().filter(([path]) => path !== "/organization/leave");

	async function expectNothingChanged() {
		const seen = await details(owner, workspace);
		expect(seen.workspace.name).toBe("Guarded");
		expect(seen.members.map(({ name, role }) => [name, role])).toEqual([
			["Owner", "owner"],
			["Admin", "admin"],
			["Plain", "member"],
			["Target", "member"],
		]);
		expect(seen.invitations.map(({ id }) => id)).toEqual([openInvitation]);
	}

	it("tells someone from outside what it says of a workspace that does not exist", async () => {
		const missing = await api("/organization/update", {
			who: stranger,
			body: { organizationId: "no-such-workspace", data: { name: "Taken" } },
		});
		expect(missing.status).toBe(404);
		const nothing = await missing.text();

		for (const outsider of [stranger, otherAdmin]) {
			for (const [path, body] of forbiddenToOutsiders()) {
				const response = await api(path, { who: outsider, body });
				expect(response.status, `${outsider.name} at ${path}`).toBe(404);
				if (!path.includes("invitation")) {
					expect(await response.text(), `${outsider.name} at ${path}`).toBe(nothing);
				}
			}
		}
		await expectNothingChanged();
	});

	it("refuses a plain member everything only an admin may do", async () => {
		for (const [path, body] of forbiddenToMembers()) {
			const response = await api(path, { who: plain, body });
			expect(response.status, path).toBe(403);
			expect(((await response.json()) as { code: string }).code, path).toBe("NOT_ALLOWED");
		}
		await expectNothingChanged();
	});

	it("refuses an admin what only an owner may do", async () => {
		const { members } = await details(owner, workspace);
		const ownerMember = members.find(({ role }) => role === "owner")?.id;
		for (const [path, body] of [
			["/organization/delete", { organizationId: workspace.id }],
			[
				"/organization/remove-member",
				{ organizationId: workspace.id, memberIdOrEmail: ownerMember },
			],
			[
				"/organization/update-member-role",
				{ organizationId: workspace.id, memberId: ownerMember, role: "member" },
			],
			[
				"/organization/update-member-role",
				{ organizationId: workspace.id, memberId: targetMember, role: "owner" },
			],
		] as [string, object][]) {
			const response = await api(path, { who: admin, body });
			expect(response.status, path).toBe(403);
		}
		await expectNothingChanged();
	});

	it("does not let an admin make themselves an owner", async () => {
		const { you } = await details(admin, workspace);
		const response = await api("/organization/update-member-role", {
			who: admin,
			body: { organizationId: workspace.id, memberId: you.memberId, role: "owner" },
		});
		expect(response.status).toBe(403);
		await expectNothingChanged();
	});

	it("does not reach another workspace's member from a workspace you do run", async () => {
		const theirs = await newWorkspace(otherAdmin, "Theirs too");
		for (const [path, body] of [
			["/organization/remove-member", { organizationId: theirs.id, memberIdOrEmail: targetMember }],
			[
				"/organization/update-member-role",
				{ organizationId: theirs.id, memberId: targetMember, role: "admin" },
			],
		] as [string, object][]) {
			const response = await api(path, { who: otherAdmin, body });
			expect(response.status, path).toBe(404);
			expect(((await response.json()) as { code: string }).code, path).toBe("MEMBER_NOT_FOUND");
		}
		await expectNothingChanged();
	});

	it("removes by member id only, so an address tells nothing about who is in a workspace", async () => {
		const response = await api("/organization/remove-member", {
			who: owner,
			body: { organizationId: workspace.id, memberIdOrEmail: target.email },
		});
		expect(response.status).toBe(404);
		await expectNothingChanged();
	});

	it("takes no role it does not know, and not several at once", async () => {
		for (const role of ["superuser", "owner,admin", ["admin", "member"]]) {
			const changed = await api("/organization/update-member-role", {
				who: owner,
				body: { organizationId: workspace.id, memberId: targetMember, role },
			});
			expect(changed.status, String(role)).toBe(400);
		}
		await expectNothingChanged();
	});

	it("shows members everyone in the workspace, and invitations only to those who run it", async () => {
		for (const who of [owner, admin]) {
			expect((await details(who, workspace)).invitations).toHaveLength(1);
		}
		const seen = await details(plain, workspace);
		expect(seen.invitations).toEqual([]);
		expect(seen.members).toHaveLength(4);
		expect(Object.keys(seen.members[0] ?? {}).sort()).toEqual(["email", "id", "name", "role"]);
	});

	it("shows someone from outside what it shows of a workspace that does not exist", async () => {
		const missing = await api("/workspaces/get?slug=no-such-workspace", { who: stranger });
		const theirs = await api(`/workspaces/get?slug=${workspace.slug}`, { who: stranger });
		expect(theirs.status).toBe(404);
		expect(theirs.status).toBe(missing.status);
		expect(await theirs.text()).toBe(await missing.text());
	});

	it("lets an admin run the workspace", async () => {
		const running = await newWorkspace(owner, "Run by an admin");
		const deputy = await newPerson("Deputy");
		await join(deputy, running, owner, "admin");
		const helper = await newPerson("Helper");
		const helperMember = await join(helper, running, deputy, "member");

		const renamed = await api("/organization/update", {
			who: deputy,
			body: { organizationId: running.id, data: { name: "Renamed" } },
		});
		expect(renamed.status).toBe(200);

		const promoted = await api("/organization/update-member-role", {
			who: deputy,
			body: { organizationId: running.id, memberId: helperMember, role: "admin" },
		});
		expect(promoted.status).toBe(200);

		const invitationId = await invite(deputy, running, newAddress());
		const withdrawn = await api("/organization/cancel-invitation", {
			who: deputy,
			body: { invitationId },
		});
		expect(withdrawn.status).toBe(200);

		const removed = await api("/organization/remove-member", {
			who: deputy,
			body: { organizationId: running.id, memberIdOrEmail: helperMember },
		});
		expect(removed.status).toBe(200);

		const seen = await details(owner, running);
		expect(seen.workspace.name).toBe("Renamed");
		expect(seen.invitations).toEqual([]);
		expect(seen.members.map(({ name }) => name)).toEqual(["Owner", "Deputy"]);
	});

	it.each([
		["its metadata, which apps' checks read", { metadata: { app: "track" } }],
		["its logo, which any page could then load", { logo: "https://evil.test/track.png" }],
		["its address", { slug: "taken-over" }],
	])("changes a workspace's name and not %s", async (_case, extra) => {
		const person = await newPerson();
		const workspace = await newWorkspace(person);
		const response = await api("/organization/update", {
			who: person,
			body: { organizationId: workspace.id, data: { name: "Renamed", ...extra } },
		});
		expect(response.status).toBe(400);
		expect((await details(person, workspace)).workspace.name).toBe(workspace.name);
	});

	it("asks someone to leave, rather than remove themselves", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const memberId = await join(second, workspace, first, "admin");
		const removed = await api("/organization/remove-member", {
			who: second,
			body: { organizationId: workspace.id, memberIdOrEmail: memberId },
		});
		expect(removed.status).toBe(400);
		expect(((await removed.json()) as { code: string }).code).toBe("LEAVE_INSTEAD");
		expect((await details(second, workspace)).you.role).toBe("admin");
	});
});

describe("a workspace always keeps an owner", () => {
	it("does not let the last owner leave, step down or remove themselves", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const { you } = await details(owner, workspace);

		const left = await api("/organization/leave", {
			who: owner,
			body: { organizationId: workspace.id },
		});
		expect(left.status).toBe(400);
		expect(((await left.json()) as { code: string }).code).toBe("LAST_OWNER");

		const stepped = await api("/organization/update-member-role", {
			who: owner,
			body: { organizationId: workspace.id, memberId: you.memberId, role: "admin" },
		});
		expect(stepped.status).toBe(400);
		expect(((await stepped.json()) as { code: string }).code).toBe("LAST_OWNER");

		const removed = await api("/organization/remove-member", {
			who: owner,
			body: { organizationId: workspace.id, memberIdOrEmail: you.memberId },
		});
		expect(removed.status).toBe(400);

		expect((await details(owner, workspace)).you.role).toBe("owner");
	});

	it("lets an owner hand over, and go", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const secondMember = await join(second, workspace, first, "member");

		const promoted = await api("/organization/update-member-role", {
			who: first,
			body: { organizationId: workspace.id, memberId: secondMember, role: "owner" },
		});
		expect(promoted.status).toBe(200);

		const left = await api("/organization/leave", {
			who: first,
			body: { organizationId: workspace.id },
		});
		expect(left.status).toBe(200);
		expect((await api(`/workspaces/get?slug=${workspace.slug}`, { who: first })).status).toBe(404);

		// The one who stayed is now the last.
		const again = await api("/organization/leave", {
			who: second,
			body: { organizationId: workspace.id },
		});
		expect(again.status).toBe(400);
	});

	it("holds in the database, however a row comes to change", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const { you } = await details(first, workspace);

		await expect(
			id.db.prepare("DELETE FROM member WHERE id = ?").bind(you.memberId).run(),
		).rejects.toThrow(/keep an owner/);
		await expect(
			id.db.prepare("UPDATE member SET role = 'member' WHERE id = ?").bind(you.memberId).run(),
		).rejects.toThrow(/keep an owner/);
		await expect(
			id.db.prepare("DELETE FROM user WHERE id = ?").bind(first.userId).run(),
		).rejects.toThrow(/keep an owner/);

		const secondMember = await join(second, workspace, first, "admin");
		await id.db.prepare("UPDATE member SET role = 'owner' WHERE id = ?").bind(secondMember).run();
		// With two, either can go.
		await id.db.prepare("DELETE FROM member WHERE id = ?").bind(you.memberId).run();
		expect((await details(second, workspace)).members).toHaveLength(1);
	});

	it("stands in the way of deleting its last owner's account", async () => {
		const owner = await newPerson();
		await newWorkspace(owner);
		await expect(
			id.db.prepare("DELETE FROM user WHERE id = ?").bind(owner.userId).run(),
		).rejects.toThrow(/must keep an owner/);
	});

	// The two requests may well run one after the other, so this says what people see. That the
	// database holds however they fall is the test above.
	it("leaves one owner when both try to leave at once", async () => {
		const [first, second] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(first);
		const secondMember = await join(second, workspace, first, "admin");
		const promoted = await api("/organization/update-member-role", {
			who: first,
			body: { organizationId: workspace.id, memberId: secondMember, role: "owner" },
		});
		expect(promoted.status).toBe(200);

		await Promise.all(
			[first, second].map((who) =>
				api("/organization/leave", { who, body: { organizationId: workspace.id } }),
			),
		);

		expect(
			await id.db
				.prepare("SELECT count(*) AS n FROM member WHERE organization_id = ? AND role = 'owner'")
				.bind(workspace.id)
				.first<number>("n"),
		).toBe(1);
	});

	it("does not let a member be in a workspace twice", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		await expect(
			id.db
				.prepare(
					"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('twice', ?, ?, 'member', 0)",
				)
				.bind(workspace.id, owner.userId)
				.run(),
		).rejects.toThrow(/UNIQUE/);
	});
});

describe("deleting a workspace", () => {
	it("takes its members and invitations with it, and nobody else's", async () => {
		const [owner, plain] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(owner);
		const other = await newWorkspace(owner, "Stays");
		await join(plain, workspace, owner);
		await invite(owner, workspace, newAddress());

		const deleted = await api("/organization/delete", {
			who: owner,
			body: { organizationId: workspace.id },
		});
		expect(deleted.status).toBe(200);

		expect(await count("organization", "id", workspace.id)).toBe(0);
		expect(await count("member", "organization_id", workspace.id)).toBe(0);
		expect(await count("invitation", "organization_id", workspace.id)).toBe(0);
		expect((await api(`/workspaces/get?slug=${workspace.slug}`, { who: plain })).status).toBe(404);
		expect((await details(owner, other)).workspace.name).toBe("Stays");
	});

	it("wants someone who signed in recently, as it cannot be undone", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		await id.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, owner.userId)
			.run();

		const refused = await api("/organization/delete", {
			who: owner,
			body: { organizationId: workspace.id },
		});
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { code: string }).code).toBe("SESSION_NOT_FRESH");
		expect(await count("organization", "id", workspace.id)).toBe(1);
	});
});

describe("invitations", () => {
	it("sends the address an email that says who, what and how, and links back here", async () => {
		const owner = await newPerson("<b>Mallory</b> https://evil.test");
		const workspace = await newWorkspace(owner, "A <b>bold</b> & Co");
		const email = newAddress();
		const invitationId = await invite(owner, workspace, email, "admin");

		const sent = await emailTo(email, /invited you/);
		expect(sent.subject).toBe("An invitation to a Gateweave ID workspace");
		expect(sent.text).toContain(`${owner.email} invited you`);
		expect(sent.text).toContain('"A <b>bold</b> & Co"');
		expect(sent.text).toContain("as admin");
		expect(sent.text).toContain(email);
		expect(sent.html).toContain("A &lt;b&gt;bold&lt;/b&gt; &amp; Co");
		expect(sent.html).not.toContain("<b>bold</b>");
		// What the person calls themselves is not something they had to prove.
		expect(sent.text).not.toContain("Mallory");
		expect(sent.text).not.toContain("evil.test");

		const link = new URL(/https:\S+/.exec(sent.text)?.[0] ?? "");
		expect(link.origin).toBe(origin);
		expect(link.pathname).toBe("/login");
		expect(link.searchParams.get("redirect")).toBe(`/invitations/${invitationId}`);
		expect(link.searchParams.get("email")).toBe(email);
	});

	it("waits for someone with no account until they make one with that address", async () => {
		const owner = await newPerson("Inviter");
		const workspace = await newWorkspace(owner, "Waiting");
		const email = newAddress();
		const invitationId = await invite(owner, workspace, email, "admin");

		const invited = await newPerson("New", email);
		const list = (await (await api("/workspaces/list", { who: invited })).json()) as {
			invitations: unknown[];
		};
		const shown = { id: invitationId, workspace: "Waiting", role: "admin", inviter: owner.email };
		expect(list.invitations).toEqual([shown]);
		const one = await api(`/workspaces/invitation?id=${invitationId}`, { who: invited });
		expect(await one.json()).toEqual(shown);

		const accepted = await api("/organization/accept-invitation", {
			who: invited,
			body: { invitationId },
		});
		expect(accepted.status).toBe(200);

		expect((await details(invited, workspace)).you.role).toBe("admin");
		expect(await statusOfInvitation(invitationId)).toBe("accepted");
		expect(
			((await (await api("/workspaces/list", { who: invited })).json()) as { invitations: [] })
				.invitations,
		).toEqual([]);
	});

	it("matches an address however it was typed", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const email = newAddress();
		const invitationId = await invite(owner, workspace, email.toUpperCase());
		const invited = await newPerson("Shouted at", email);
		const accepted = await api("/organization/accept-invitation", {
			who: invited,
			body: { invitationId },
		});
		expect(accepted.status).toBe(200);
	});

	it("leaves the session as it was when accepting", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const invited = await newPerson();
		await join(invited, workspace, owner);
		const session = await api("/get-session", { who: invited });
		expect(await session.json()).toMatchObject({ user: { id: invited.userId } });
	});

	it("declining leaves no place in the workspace", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const invited = await newPerson();
		const invitationId = await invite(owner, workspace, invited.email);
		const declined = await api("/organization/reject-invitation", {
			who: invited,
			body: { invitationId },
		});
		expect(declined.status).toBe(200);
		expect(await statusOfInvitation(invitationId)).toBe("rejected");
		expect((await api(`/workspaces/get?slug=${workspace.slug}`, { who: invited })).status).toBe(
			404,
		);
	});

	it("is not for an account whose address is not proven, whatever it says it is", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const invited = await newPerson();
		const invitationId = await invite(owner, workspace, invited.email);
		await id.db
			.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
			.bind(invited.userId)
			.run();

		const seen = await api(`/workspaces/invitation?id=${invitationId}`, { who: invited });
		expect(seen.status).toBe(404);
		const accepted = await api("/organization/accept-invitation", {
			who: invited,
			body: { invitationId },
		});
		expect(accepted.status).toBe(404);
		expect(await statusOfInvitation(invitationId)).toBe("pending");
	});

	describe("for someone else, or for nobody", () => {
		const paths = (invitationId: string): [string, string, object | undefined][] => [
			["see", `/workspaces/invitation?id=${invitationId}`, undefined],
			["accept", "/organization/accept-invitation", { invitationId }],
			["decline", "/organization/reject-invitation", { invitationId }],
		];

		async function answers(who: Who, invitationId: string) {
			return Promise.all(
				paths(invitationId).map(async ([, path, body]) => {
					const response = await api(path, { who, ...(body && { body }) });
					return { status: response.status, text: await response.text() };
				}),
			);
		}

		it("answers the wrong address as it answers an invitation that does not exist", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const invitationId = await invite(owner, workspace, newAddress());
			const wrong = await newPerson();

			const nothing = await answers(wrong, "no-such-invitation");
			expect(nothing.map(({ status }) => status)).toEqual([404, 404, 404]);
			expect(await answers(wrong, invitationId)).toEqual(nothing);

			// Not the person who sent it either, or anyone else in the workspace.
			expect(await answers(owner, invitationId)).toEqual(nothing);

			expect(await statusOfInvitation(invitationId)).toBe("pending");
			expect(await count("member", "user_id", wrong.userId)).toBe(0);
		});

		it.each([
			[
				"expired",
				async (invitationId: string) => {
					await id.db
						.prepare("UPDATE invitation SET expires_at = ? WHERE id = ?")
						.bind(Date.now() - 1000, invitationId)
						.run();
				},
			],
			[
				"withdrawn",
				async (invitationId: string, owner: Person) => {
					const withdrawn = await api("/organization/cancel-invitation", {
						who: owner,
						body: { invitationId },
					});
					expect(withdrawn.status).toBe(200);
				},
			],
		])("answers the right address the same once it is %s", async (_case, end) => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const invited = await newPerson();
			const invitationId = await invite(owner, workspace, invited.email);
			const nothing = await answers(invited, "no-such-invitation");

			await end(invitationId, owner);

			expect(await answers(invited, invitationId)).toEqual(nothing);
			expect((await api(`/workspaces/get?slug=${workspace.slug}`, { who: invited })).status).toBe(
				404,
			);
		});

		it("cannot be used twice", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const invited = await newPerson();
			const invitationId = await invite(owner, workspace, invited.email);
			const body = { invitationId };
			expect((await api("/organization/accept-invitation", { who: invited, body })).status).toBe(
				200,
			);
			expect((await api("/organization/accept-invitation", { who: invited, body })).status).toBe(
				404,
			);
			expect(await count("member", "user_id", invited.userId)).toBe(1);
		});

		it("does not survive being asked for again: the old link stops working", async () => {
			const owner = await newPerson();
			const workspace = await newWorkspace(owner);
			const invited = await newPerson();
			const first = await invite(owner, workspace, invited.email);
			const second = await invite(owner, workspace, invited.email);
			expect(second).not.toBe(first);
			expect(await statusOfInvitation(first)).toBe("canceled");
			const { invitations } = await details(owner, workspace);
			expect(invitations.map(({ id }) => id)).toEqual([second]);
		});
	});

	it.each([
		["an owner", { role: "owner" }],
		["several roles", { role: ["admin", "member"] }],
		["a role nothing knows", { role: "superuser" }],
		["something the page does not send", { role: "member", resend: true }],
		["a group", { role: "member", teamId: "a-team" }],
		["no address", { role: "member", email: "not-an-address" }],
	])("refuses inviting %s", async (_case, fields) => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const response = await api("/organization/invite-member", {
			who: owner,
			body: { organizationId: workspace.id, email: newAddress(), ...fields },
		});
		expect(response.status).toBe(400);
		expect((await details(owner, workspace)).invitations).toEqual([]);
	});

	it("says when someone is already in the workspace", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const already = await newPerson();
		await join(already, workspace, owner);
		const response = await api("/organization/invite-member", {
			who: owner,
			body: { organizationId: workspace.id, email: already.email, role: "member" },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe(
			"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
		);
	});

	it("gives one address only so many invitations, whoever sends them", async () => {
		const email = newAddress();
		for (let sent = 0; sent < 3; sent++) {
			const owner = await newPerson();
			await invite(owner, await newWorkspace(owner), email);
		}
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const refused = await api("/organization/invite-member", {
			who: owner,
			body: { organizationId: workspace.id, email: email.toUpperCase(), role: "member" },
		});
		expect(refused.status).toBe(429);
		expect(((await refused.json()) as { code: string }).code).toBe("TOO_MANY_INVITATIONS");
		expect((await details(owner, workspace)).invitations).toEqual([]);
		// It leaves the address room for what only email can do, such as resetting a password.
		expect((await id.emails()).filter(({ to }) => to === email)).toHaveLength(3);
	});

	it("gives one person only so many invitations, whichever workspace they are for", async () => {
		const owner = await newPerson();
		const workspaces = [await newWorkspace(owner), await newWorkspace(owner)];
		const ask = (index: number) =>
			api("/organization/invite-member", {
				who: owner,
				client: newClient(),
				body: {
					organizationId: workspaces[index % 2]?.id,
					email: newAddress(),
					role: "member",
				},
			});
		// The limit gives back one every two minutes, which a slow machine can reach.
		let refused = 0;
		for (let index = 0; index < 32 && !refused; index++) {
			if ((await ask(index)).status === 429) refused = index;
		}
		expect(refused).toBeGreaterThanOrEqual(30);
	});

	it("limits how fast one client can make workspaces", async () => {
		const person = await newPerson();
		const client = newClient();
		const statuses: number[] = [];
		for (let tries = 0; tries < 6; tries++) {
			const response = await api("/organization/create", {
				who: person,
				client,
				body: { name: "Fast", slug: `fast-${++slugs}` },
			});
			statuses.push(response.status);
		}
		expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
		expect(statuses[5]).toBe(429);
	});

	it("limits how fast one client can invite", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const client = newClient();
		// One comes back every three seconds, so a slow run can get a little past twenty. Without this
		// limit nothing stops these twenty-five, as one person's own allowance is thirty an hour.
		let status = 0;
		for (let tries = 0; tries < 25 && status !== 429; tries++) {
			const response = await api("/organization/invite-member", {
				who: owner,
				client,
				body: { organizationId: workspace.id, email: newAddress(), role: "member" },
			});
			status = response.status;
		}
		expect(status).toBe(429);
	});

	it("stops showing an invitation once its time is up", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const invitationId = await invite(owner, workspace, newAddress());
		expect((await details(owner, workspace)).invitations.map((entry) => entry.id)).toEqual([
			invitationId,
		]);
		await id.db
			.prepare("UPDATE invitation SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1_000, invitationId)
			.run();
		expect((await details(owner, workspace)).invitations).toEqual([]);
	});
});

describe("on a deployment that sends no email", () => {
	it("still has workspaces, and says that it cannot invite anyone", async () => {
		const bare = await startId("https://bare.test", { email: false, github: true });
		const barePost = (path: string, client: string, body: object, cookie?: string) =>
			bare.fetch(`https://bare.test/api/auth${path}`, {
				method: "POST",
				headers: {
					origin: "https://bare.test",
					"cf-connecting-ip": client,
					"content-type": "application/json",
					...(cookie && { cookie }),
				},
				body: JSON.stringify(body),
			});
		try {
			const client = newClient();
			const started = await barePost("/sign-in/social", client, {
				provider: "github",
				callbackURL: "/account",
			});
			const { url } = (await started.json()) as { url: string };
			const state = new URL(url).searchParams.get("state") ?? "";
			const someone = {
				id: 7,
				login: "solo",
				name: "Solo",
				emails: [{ email: "solo@example.com", primary: true, verified: true }],
			};
			const back = await bare.fetch(
				`https://bare.test/api/auth/callback/github?${new URLSearchParams({
					code: gitHubCode(someone),
					state,
				})}`,
				{ headers: { "cf-connecting-ip": client, cookie: cookieOf(started) } },
			);
			const cookie = cookieOf(back);

			const made = await barePost(
				"/organization/create",
				client,
				{ name: "Solo", slug: "solo" },
				cookie,
			);
			expect(made.status).toBe(200);
			const { id: organizationId } = (await made.json()) as { id: string };

			const invited = await barePost(
				"/organization/invite-member",
				client,
				{ organizationId, email: "someone@example.com", role: "member" },
				cookie,
			);
			expect(invited.status).toBe(400);
			expect(((await invited.json()) as { code: string }).code).toBe("EMAIL_NOT_CONFIGURED");
			expect(await bare.db.prepare("SELECT count(*) AS n FROM invitation").first<number>("n")).toBe(
				0,
			);
		} finally {
			await bare.dispose();
		}
	});
});

describe("what the log keeps", () => {
	it("records nothing the plugin refused", async () => {
		const owner = await newPerson();
		const workspace = await newWorkspace(owner);
		const taken = await api("/organization/create", {
			who: owner,
			body: { name: "Again", slug: workspace.slug },
		});
		expect(taken.status).toBe(400);
		// The log is written after the response, so something that is recorded shows it has caught up.
		await api("/organization/update", {
			who: owner,
			body: { organizationId: workspace.id, data: { name: "Renamed" } },
		});
		await id.auditEventRecorded(owner.userId, { type: "workspace_renamed" });
		const made = (await id.auditEvents(owner.userId)).filter(
			(event) => event.type === "workspace_created",
		);
		expect(made).toHaveLength(1);
	});

	it("records each change, by whom, to whom and where", async () => {
		const owner = await newPerson("Owner");
		const client = newClient();
		const who = { cookie: owner.cookie, client };
		const made = await api("/organization/create", {
			who,
			userAgent: CHROME_ON_WINDOWS,
			body: { name: "Logged", slug: `logged-${++slugs}` },
		});
		const { id: workspaceId, slug } = (await made.json()) as { id: string; slug: string };
		const workspace = { id: workspaceId, slug, name: "Logged" };
		await id.auditEventRecorded(owner.userId, {
			type: "workspace_created",
			actor_id: owner.userId,
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Logged" }),
			ip: client,
			device: "Chrome on Windows",
		});

		const renamed = await api("/organization/update", {
			who,
			body: { organizationId: workspaceId, data: { name: "Still logged" } },
		});
		expect(renamed.status).toBe(200);
		await id.auditEventRecorded(owner.userId, {
			type: "workspace_renamed",
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Still logged" }),
		});

		const address = newAddress();
		const withdrawnId = await invite(owner, workspace, address, "admin");
		await id.auditEventRecorded(owner.userId, {
			type: "member_invited",
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Still logged", role: "admin" }),
		});
		const withdrawn = await api("/organization/cancel-invitation", {
			who,
			body: { invitationId: withdrawnId },
		});
		expect(withdrawn.status).toBe(200);
		await id.auditEventRecorded(owner.userId, {
			type: "invitation_canceled",
			workspace_id: workspaceId,
		});

		const plain = await newPerson("Plain");
		const plainMember = await join(plain, workspace, owner, "member");
		await id.auditEventRecorded(plain.userId, {
			type: "invitation_accepted",
			actor_id: plain.userId,
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Still logged", role: "member" }),
		});

		const declining = await newPerson("Declining");
		const declined = await api("/organization/reject-invitation", {
			who: declining,
			body: { invitationId: await invite(owner, workspace, declining.email) },
		});
		expect(declined.status).toBe(200);
		await id.auditEventRecorded(declining.userId, {
			type: "invitation_declined",
			workspace_id: workspaceId,
		});

		const promoted = await api("/organization/update-member-role", {
			who,
			body: { organizationId: workspaceId, memberId: plainMember, role: "admin" },
		});
		expect(promoted.status).toBe(200);
		await id.auditEventRecorded(plain.userId, {
			type: "member_role_changed",
			actor_id: owner.userId,
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Still logged", role: "admin" }),
		});

		const removed = await api("/organization/remove-member", {
			who,
			body: { organizationId: workspaceId, memberIdOrEmail: plainMember },
		});
		expect(removed.status).toBe(200);
		await id.auditEventRecorded(plain.userId, {
			type: "member_removed",
			actor_id: owner.userId,
			workspace_id: workspaceId,
			ip: client,
		});

		const leaving = await newPerson("Leaving");
		await join(leaving, workspace, owner);
		const left = await api("/organization/leave", {
			who: leaving,
			body: { organizationId: workspaceId },
		});
		expect(left.status).toBe(200);
		await id.auditEventRecorded(leaving.userId, {
			type: "member_left",
			actor_id: leaving.userId,
			workspace_id: workspaceId,
		});

		const deleted = await api("/organization/delete", {
			who,
			body: { organizationId: workspaceId },
		});
		expect(deleted.status).toBe(200);
		// Its name outlives it, and the rows about it outlive it too.
		await id.auditEventRecorded(owner.userId, {
			type: "workspace_deleted",
			workspace_id: workspaceId,
			detail: JSON.stringify({ workspace: "Still logged" }),
		});
		expect(await count("audit_event", "workspace_id", workspaceId)).toBeGreaterThan(8);

		// No row holds an address, however it came to be.
		const { results } = await id.db
			.prepare("SELECT * FROM audit_event WHERE workspace_id = ?")
			.bind(workspaceId)
			.all();
		expect(JSON.stringify(results)).not.toContain("@example.com");
	});

	it("records nothing for what was refused", async () => {
		const [owner, plain] = [await newPerson(), await newPerson()];
		const workspace = await newWorkspace(owner);
		await join(plain, workspace, owner);
		const refused = await api("/organization/update", {
			who: plain,
			body: { organizationId: workspace.id, data: { name: "Nope" } },
		});
		expect(refused.status).toBe(403);

		// Written after the response, so wait for something written later by the same person.
		const left = await api("/organization/leave", {
			who: plain,
			body: { organizationId: workspace.id },
		});
		expect(left.status).toBe(200);
		await id.auditEventRecorded(plain.userId, { type: "member_left" });
		const events = await id.auditEvents(plain.userId);
		expect(events.map(({ type }) => type)).not.toContain("workspace_renamed");
	});

	it("shows each side what it needs, and not where the other person was", async () => {
		const ada = await newPerson("Ada");
		const bob = await newPerson("Bob");
		const client = newClient();
		const adaHere = { cookie: ada.cookie, client };
		const workspace = await newWorkspace(ada, "Shared");
		const bobMember = await join(bob, workspace, ada);
		const promoted = await api("/organization/update-member-role", {
			who: adaHere,
			userAgent: CHROME_ON_WINDOWS,
			body: { organizationId: workspace.id, memberId: bobMember, role: "admin" },
		});
		expect(promoted.status).toBe(200);
		const removed = await api("/organization/remove-member", {
			who: adaHere,
			userAgent: CHROME_ON_WINDOWS,
			body: { organizationId: workspace.id, memberIdOrEmail: bobMember },
		});
		expect(removed.status).toBe(200);
		await id.auditEventRecorded(bob.userId, { type: "member_removed" });

		interface Activity {
			type: string;
			byOther: boolean;
			other: string | null;
			ip: string | null;
			device: string | null;
		}
		const activityOf = async (who: Who) =>
			((await (await api("/account/activity", { who })).json()) as { events: Activity[] }).events;

		const whatBobSees = (await activityOf(bob)).filter(({ type }) => type === "member_removed");
		expect(whatBobSees).toEqual([
			expect.objectContaining({ byOther: true, other: "Ada", ip: null, device: null }),
		]);

		const whatAdaSees = (await activityOf(ada)).filter(({ type }) => type === "member_removed");
		expect(whatAdaSees).toEqual([
			expect.objectContaining({
				byOther: false,
				other: "Bob",
				ip: client,
				device: "Chrome on Windows",
			}),
		]);
	});
});
