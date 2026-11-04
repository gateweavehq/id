import { describe, expect, it, vi } from "vitest";
import { createMailer, parseSender } from "./mailer";

describe("parseSender", () => {
	it("reads a named or a bare address", () => {
		expect(parseSender("Gateweave ID <id@example.com>")).toEqual({
			name: "Gateweave ID",
			email: "id@example.com",
		});
		expect(parseSender('"ID, by Gateweave" <id@example.com>')).toEqual({
			name: "ID, by Gateweave",
			email: "id@example.com",
		});
		expect(parseSender(" id@example.com ")).toBe("id@example.com");
		expect(parseSender("<id@example.com>")).toBe("id@example.com");
	});

	it("rejects anything that is not an address", () => {
		expect(parseSender("Gateweave ID")).toBeUndefined();
		expect(parseSender("ID <not an address>")).toBeUndefined();
		expect(parseSender("")).toBeUndefined();
	});
});

describe("createMailer", () => {
	const email = { to: "maya@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" };

	it("sends from the configured sender", async () => {
		const send = vi.fn(async () => ({ messageId: "1" }));
		const mailer = createMailer({ send } as unknown as SendEmail, "ID <id@example.com>");
		await mailer?.send(email);
		expect(send).toHaveBeenCalledWith({
			from: { name: "ID", email: "id@example.com" },
			...email,
		});
	});

	it("is off without a binding or a valid sender", () => {
		const binding = { send: vi.fn() } as unknown as SendEmail;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(createMailer(undefined, "id@example.com")).toBeUndefined();
		expect(createMailer(binding, undefined)).toBeUndefined();
		expect(createMailer(binding, "not an address")).toBeUndefined();
	});
});
