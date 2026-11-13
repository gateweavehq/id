import { beforeEach, describe, expect, it, vi } from "vitest";
import { configuredJurisdiction, objectsIn } from "./jurisdiction";

// Where a deployment keeps its Durable Objects (DURABLE_OBJECT_JURISDICTION). Local
// workerd has no jurisdictions, so the namespace here is a stand-in that says which one it got.

const { env } = vi.hoisted(() => ({ env: {} as { DURABLE_OBJECT_JURISDICTION?: string } }));
vi.mock("cloudflare:workers", () => ({ env }));

function namespace(name = "none") {
	return {
		name,
		jurisdiction: vi.fn((jurisdiction: string) => namespace(jurisdiction)),
	} as unknown as DurableObjectNamespace & { name: string };
}

describe("the deployment's jurisdiction", () => {
	beforeEach(() => {
		delete env.DURABLE_OBJECT_JURISDICTION;
	});

	it("is none when unset or blank", () => {
		expect(configuredJurisdiction()).toBeNull();
		env.DURABLE_OBJECT_JURISDICTION = " ";
		expect(configuredJurisdiction()).toBeNull();
	});

	it("is one of Cloudflare's, however it is written", () => {
		env.DURABLE_OBJECT_JURISDICTION = " EU ";
		expect(configuredJurisdiction()).toBe("eu");
	});

	it("refuses one Cloudflare doesn't have, rather than keeping data anywhere", () => {
		env.DURABLE_OBJECT_JURISDICTION = "de";
		expect(() => configuredJurisdiction()).toThrow('DURABLE_OBJECT_JURISDICTION is "de"');
	});
});

describe("a namespace's objects", () => {
	it("are the namespace's own outside any jurisdiction", () => {
		const objects = namespace();
		expect(objectsIn(objects, null)).toBe(objects);
		expect(objects.jurisdiction).not.toHaveBeenCalled();
	});

	it("are the jurisdiction's in one", () => {
		const objects = namespace();
		expect((objectsIn(objects, "eu") as typeof objects).name).toBe("eu");
		expect(() => objectsIn(objects, "mars")).toThrow('No jurisdiction "mars"');
	});
});
