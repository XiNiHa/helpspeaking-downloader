import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { toBase64Url } from "./base64url";

const encoder = new TextEncoder();

const sha256 = (value: string) => crypto.subtle.digest("SHA-256", encoder.encode(value));

const timingSafeEqual = (left: string, right: string) =>
	Effect.promise(async () => {
		const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)]);
		const leftBytes = new Uint8Array(leftDigest);
		const rightBytes = new Uint8Array(rightDigest);
		return leftBytes.reduce((diff, byte, index) => diff | (byte ^ rightBytes[index]!), 0) === 0;
	});

const sign = (payload: string) =>
	Effect.promise(async () => {
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(env.SESSION_SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		return toBase64Url(
			new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))),
		);
	});

export const SESSION_MAX_AGE = "400 days";

export const isCorrectPattern = (pattern: string) => timingSafeEqual(pattern, env.UNLOCK_PATTERN);

export const issueSessionToken = Effect.gen(function* () {
	const payload = String(Date.now());
	return `${payload}.${yield* sign(payload)}`;
});

export const isValidSessionToken = Effect.fn("isValidSessionToken")(function* (token: string) {
	const separator = token.lastIndexOf(".");
	if (separator <= 0) {
		return false;
	}
	const expected = yield* sign(token.slice(0, separator));
	return yield* timingSafeEqual(token.slice(separator + 1), expected);
});
