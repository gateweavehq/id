import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A software authenticator, so that the Worker tests can do what no real one will: sign for another
// site, skip the check of who is there, or send a stolen credential's id. e2e/ uses Chromium's
// virtual authenticator for what a browser does.

/** What a test can make this authenticator do, in place of what a real one would. */
export interface Ceremony {
	/** The site the browser says it is on. */
	origin?: string;
	/** The relying party the authenticator signs for. */
	rpId?: string;
	/** Whether it checked who is there, with a fingerprint or a PIN. */
	userVerified?: boolean;
	/** The challenge it signs, in place of the one it was given. */
	challenge?: string;
	/** `webauthn.create` or `webauthn.get`, in place of the right one. */
	type?: string;
	/** The signature counter to report. It goes up by itself otherwise. */
	counter?: number;
}

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const BACKUP_ELIGIBLE = 0x08;
const BACKED_UP = 0x10;
const ATTESTED_CREDENTIAL = 0x40;

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Just enough CBOR for an attestation object and a public key. */
function cbor(value: number | string | Uint8Array | Map<number | string, unknown>): Buffer {
	function head(major: number, length: number) {
		if (length < 24) return Buffer.from([(major << 5) | length]);
		if (length < 256) return Buffer.from([(major << 5) | 24, length]);
		return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
	}
	if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === "string") {
		const text = Buffer.from(value);
		return Buffer.concat([head(3, text.length), text]);
	}
	if (value instanceof Map) {
		const entries = [...value].flatMap(([key, item]) => [cbor(key), cbor(item as Uint8Array)]);
		return Buffer.concat([head(5, value.size), ...entries]);
	}
	return Buffer.concat([head(2, value.length), value]);
}

export class FakeAuthenticator {
	#keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	#counter = 0;
	#rpId: string;
	#origin: string;
	readonly credentialId: string;

	/** `credentialId` is the id of a credential someone else has, for a test that tries to take it. */
	constructor(origin: string, credentialId = base64url(randomBytes(16))) {
		this.#origin = origin;
		this.#rpId = new URL(origin).hostname;
		this.credentialId = credentialId;
	}

	#clientData(fallbackType: string, challenge: string, ceremony: Ceremony) {
		return Buffer.from(
			JSON.stringify({
				type: ceremony.type ?? fallbackType,
				challenge: ceremony.challenge ?? challenge,
				origin: ceremony.origin ?? this.#origin,
				crossOrigin: false,
			}),
		);
	}

	#authenticatorData(ceremony: Ceremony, extra: { flags: number; rest: Buffer }) {
		const flags =
			USER_PRESENT |
			BACKUP_ELIGIBLE |
			BACKED_UP |
			(ceremony.userVerified === false ? 0 : USER_VERIFIED) |
			extra.flags;
		this.#counter = ceremony.counter ?? this.#counter + 1;
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(this.#counter);
		return Buffer.concat([
			sha256(ceremony.rpId ?? this.#rpId),
			Buffer.from([flags]),
			counter,
			extra.rest,
		]);
	}

	/** What `navigator.credentials.create` would give the page. */
	register(options: { challenge: string }, ceremony: Ceremony = {}) {
		const { x, y } = this.#keys.publicKey.export({ format: "jwk" });
		const publicKey = cbor(
			new Map<number, unknown>([
				[1, 2], // An elliptic curve key,
				[3, -7], // for ES256,
				[-1, 1], // on P-256.
				[-2, Buffer.from(x ?? "", "base64url")],
				[-3, Buffer.from(y ?? "", "base64url")],
			]),
		);
		const id = Buffer.from(this.credentialId, "base64url");
		const length = Buffer.alloc(2);
		length.writeUInt16BE(id.length);
		const authData = this.#authenticatorData(ceremony, {
			flags: ATTESTED_CREDENTIAL,
			rest: Buffer.concat([Buffer.alloc(16), length, id, publicKey]),
		});
		const attestationObject = cbor(
			new Map<string, unknown>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]),
		);
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: base64url(this.#clientData("webauthn.create", options.challenge, ceremony)),
				attestationObject: base64url(attestationObject),
				transports: ["internal"],
			},
		};
	}

	/** What `navigator.credentials.get` would give the page. */
	signIn(options: { challenge: string }, ceremony: Ceremony = {}) {
		const clientData = this.#clientData("webauthn.get", options.challenge, ceremony);
		const authData = this.#authenticatorData(ceremony, { flags: 0, rest: Buffer.alloc(0) });
		const signature = sign(
			"sha256",
			Buffer.concat([authData, sha256(clientData)]),
			this.#keys.privateKey,
		);
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: base64url(clientData),
				authenticatorData: base64url(authData),
				signature: base64url(signature),
			},
		};
	}
}
