import { count, gt, lt } from "drizzle-orm";
import { Effect } from "effect";
import { unlockFailures } from "../db/schema";
import { Db } from "./db";

const GLOBAL_FAILURE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

export const isUnlockLockedOut = Effect.fn("isUnlockLockedOut")(function* () {
	const db = yield* Db;
	const [row] = yield* db
		.select({ failures: count() })
		.from(unlockFailures)
		.where(gt(unlockFailures.failedAt, Date.now() - WINDOW_MS));
	return (row?.failures ?? 0) >= GLOBAL_FAILURE_LIMIT;
}, Effect.orDie);

export const recordUnlockFailure = Effect.fn("recordUnlockFailure")(function* () {
	const db = yield* Db;
	const now = Date.now();
	yield* db.delete(unlockFailures).where(lt(unlockFailures.failedAt, now - WINDOW_MS));
	yield* db.insert(unlockFailures).values({ failedAt: now });
}, Effect.orDie);
