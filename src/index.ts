import puppeteer from "@cloudflare/puppeteer";
import { Context, Effect, pipe } from "effect";

class CloudflareEnv extends Context.Tag("CloudflareEnv")<CloudflareEnv, Cloudflare.Env>() {}

const runApp = Effect.gen(function* () {
	const env = yield* CloudflareEnv;
	const browser = yield* Effect.tryPromise(() => puppeteer.launch(env.BROWSER));
	const page = yield* Effect.tryPromise(() => browser.newPage());
	yield* Effect.tryPromise(() => page.goto("https://helpspeaking.kr"));
	const img = yield* Effect.tryPromise(() => page.screenshot());
	return img;
});

export default {
	async fetch(_, env) {
		const img = await Effect.runPromise(pipe(runApp, Effect.provideService(CloudflareEnv, env)));

		return new Response(img, {
			headers: { "Content-Type": "image/png" },
		});
	},
} satisfies ExportedHandler<Cloudflare.Env>;
