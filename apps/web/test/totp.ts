import { createHmac } from "node:crypto";

// An authenticator app, written from RFC 6238 rather than with the library ID uses, so that a test
// using it also shows that what ID hands out works in an app it has never met.

const STEP_SECONDS = 30;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function fromBase32(text: string): Buffer {
	let bits = "";
	for (const letter of text.toUpperCase().replace(/=+$/, "")) {
		const value = BASE32.indexOf(letter);
		if (value < 0) throw new Error(`Not base32: ${letter}`);
		bits += value.toString(2).padStart(5, "0");
	}
	const bytes = bits.match(/.{8}/g) ?? [];
	return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** The code for a key, as a person would see it, `steps` steps of 30 seconds from `at`. */
export function totp(base32Key: string, { steps = 0, at = Date.now(), digits = 6 } = {}): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / STEP_SECONDS) + steps));
	const hash = createHmac("sha1", fromBase32(base32Key)).update(counter).digest();
	const offset = (hash[hash.length - 1] ?? 0) & 0xf;
	const code = hash.readUInt32BE(offset) & 0x7fffffff;
	return String(code % 10 ** digits).padStart(digits, "0");
}

/** A code that is not good for this key now, nor at either step around now. */
export function wrongCode(base32Key: string, seed = 1): string {
	const good = [-1, 0, 1].map((steps) => totp(base32Key, { steps }));
	for (let candidate = seed; ; candidate++) {
		const code = String(candidate % 1_000_000).padStart(6, "0");
		if (!good.includes(code)) return code;
	}
}
