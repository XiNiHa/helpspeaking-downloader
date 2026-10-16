import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:workers";
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1";
import { Context, Effect, Layer } from "effect";

const makeDb = SQLiteD1Drizzle.makeWithDefaults({});

export class Db extends Context.Service<Db, Effect.Success<typeof makeDb>>()("helpspeaking/Db") {
	static readonly layer = Layer.effect(Db, makeDb).pipe(
		Layer.provide(D1Client.layer({ db: env.DB })),
		Layer.orDie,
	);
}
