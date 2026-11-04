import { describe, expect, it } from "vitest";
import {
	can,
	slugFrom,
	type WorkspaceRole,
	workspaceFailure,
	workspaceName,
	workspaceSlug,
} from "./workspace";

const everyone: { role: string }[] = [{ role: "owner" }, { role: "admin" }, { role: "member" }];

function allowed(check: (actor: { role: string }) => boolean): string[] {
	return everyone.filter(check).map(({ role }) => role);
}

describe("can", () => {
	it("lets every member see and leave", () => {
		expect(allowed((actor) => can(actor, "see"))).toEqual(["owner", "admin", "member"]);
		expect(allowed((actor) => can(actor, "leave"))).toEqual(["owner", "admin", "member"]);
	});

	it.each(["rename", "invite", "seeInvitations", "cancelInvitation"] as const)(
		"keeps %s to owners and admins",
		(action) => {
			expect(allowed((actor) => can(actor, action))).toEqual(["owner", "admin"]);
		},
	);

	it("keeps deleting to owners", () => {
		expect(allowed((actor) => can(actor, "delete"))).toEqual(["owner"]);
	});

	const changes: [WorkspaceRole, WorkspaceRole, string[]][] = [
		["member", "admin", ["owner", "admin"]],
		["admin", "member", ["owner", "admin"]],
		["member", "owner", ["owner"]],
		["admin", "owner", ["owner"]],
		["owner", "admin", ["owner"]],
		["owner", "member", ["owner"]],
	];

	it.each(changes)("lets the right people make a %s into a %s", (role, to, who) => {
		expect(allowed((actor) => can(actor, "changeRole", { role, to }))).toEqual(who);
	});

	it.each([
		["member", ["owner", "admin"]],
		["admin", ["owner", "admin"]],
		["owner", ["owner"]],
	] as const)("lets the right people remove a %s", (role, who) => {
		expect(allowed((actor) => can(actor, "removeMember", { role }))).toEqual(who);
	});

	it("gives someone with no place in the workspace nothing", () => {
		expect(can(null, "see")).toBe(false);
		expect(can(null, "leave")).toBe(false);
		expect(can(null, "removeMember", { role: "member" })).toBe(false);
	});

	it("gives a role it has not heard of nothing, as rights are granted by name", () => {
		for (const role of ["", "Owner", "owner,admin", "billing"]) {
			const actor = { role };
			expect(can(actor, "see")).toBe(false);
			expect(can(actor, "rename")).toBe(false);
			expect(can(actor, "delete")).toBe(false);
			expect(can(actor, "changeRole", { role: "member", to: "admin" })).toBe(false);
			expect(can(actor, "removeMember", { role: "member" })).toBe(false);
		}
	});
});

describe("a workspace's name", () => {
	it.each([
		"Acme",
		"Acme Inc.",
		"Çay & Kahve",
		"Node.js team",
		"می\u200Cخواهم",
		"👨\u200D👩\u200D👧 Family",
	])("takes %s", (name) => {
		expect(workspaceName.safeParse(name).success).toBe(true);
	});

	it.each([
		["nothing", ""],
		["too much", "x".repeat(61)],
		["space around it", " Acme "],
		["a link", "Win at https://evil.test"],
		["a new line", "Acme\nFree money"],
		["a right-to-left override", "Acme‮test"],
		["a character that hides", "Ac​me"],
	])("refuses %s", (_case, name) => {
		expect(workspaceName.safeParse(name).success).toBe(false);
	});
});

describe("a workspace's address", () => {
	it.each(["ab", "acme", "acme-inc", "a1-b2", "x".repeat(40)])("takes %s", (slug) => {
		expect(workspaceSlug.safeParse(slug).success).toBe(true);
	});

	it.each(["", "a", "Acme", "-acme", "acme-", "ac--me", "ac me", "ac_me", "x".repeat(41), "../x"])(
		"refuses %s",
		(slug) => {
			expect(workspaceSlug.safeParse(slug).success).toBe(false);
		},
	);
});

describe("slugFrom", () => {
	it.each([
		["Acme Inc.", "acme-inc"],
		["  Çay & Kahve  ", "cay-kahve"],
		["Kapı İşleri", "kapi-isleri"],
		["Node.js", "node-js"],
		["日本語", ""],
		["x".repeat(60), "x".repeat(40)],
		[`${"x".repeat(39)} y`, "x".repeat(39)],
	])("makes an address of %s", (name, slug) => {
		expect(slugFrom(name)).toBe(slug);
	});
});

describe("workspaceFailure", () => {
	it("speaks of workspaces where the plugin speaks of organizations", () => {
		expect(
			workspaceFailure({
				code: "ORGANIZATION_ALREADY_EXISTS",
				message: "Organization already exists",
			}),
		).toBe("That address is taken. Try another.");
	});

	it("keeps words it has none of its own for", () => {
		expect(workspaceFailure({ code: "LAST_OWNER", message: "A workspace needs an owner." })).toBe(
			"A workspace needs an owner.",
		);
		expect(workspaceFailure({})).toBe("Something went wrong");
	});
});
