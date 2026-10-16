import { env } from "cloudflare:workers";
import { desc, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runs } from "../db/schema";
import { type Run, RunAlreadyActive, type RunTrigger } from "../shared/api";
import { Db } from "./db";

const STALE_RUN_MS = 4 * 60 * 60 * 1000;

export interface RunParams {
	readonly runId: string;
	readonly trigger: RunTrigger;
	readonly lessonId: string | null;
}

type RunRow = typeof runs.$inferSelect;

const toApiRun = (row: RunRow): Run => {
	const isStale = row.status === "running" && row.startedAt < Date.now() - STALE_RUN_MS;
	return {
		id: row.id,
		trigger: row.trigger,
		lessonId: Option.fromNullOr(row.lessonId),
		status: isStale ? "failed" : row.status,
		step: Option.fromNullOr(row.step),
		error: isStale ? Option.some("실행이 응답하지 않아요") : Option.fromNullOr(row.error),
		screenshot: Option.fromNullOr(row.screenshot),
		startedAt: row.startedAt,
		finishedAt: Option.fromNullOr(row.finishedAt),
	};
};

export const latestRun = Effect.gen(function* () {
	const db = yield* Db;
	const [row] = yield* db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1);
	return Option.map(Option.fromUndefinedOr(row), toApiRun);
}).pipe(Effect.orDie);

export const findRunScreenshot = Effect.fn("findRunScreenshot")(function* (id: string) {
	const db = yield* Db;
	const [row] = yield* db
		.select({ screenshot: runs.screenshot })
		.from(runs)
		.where(eq(runs.id, id))
		.limit(1);
	return row?.screenshot ?? null;
}, Effect.orDie);

export const updateRun = Effect.fn("updateRun")(function* (
	id: string,
	patch: Partial<Omit<RunRow, "id">>,
) {
	const db = yield* Db;
	yield* db.update(runs).set(patch).where(eq(runs.id, id));
}, Effect.orDie);

export const finishRun = (
	id: string,
	outcome: { status: "succeeded" } | { status: "failed"; error: string },
) => updateRun(id, { ...outcome, step: null, finishedAt: Date.now() });

export const startRun = Effect.fn("startRun")(function* (
	trigger: RunTrigger,
	lessonId: string | null = null,
) {
	const db = yield* Db;
	const runId = crypto.randomUUID();
	const now = Date.now();
	const inserted = yield* db
		.all<RunRow>(
			sql`INSERT INTO runs (id, trigger, lesson_id, status, started_at)
				SELECT ${runId}, ${trigger}, ${lessonId}, 'running', ${now}
				WHERE NOT EXISTS (
					SELECT 1 FROM runs WHERE status = 'running' AND started_at > ${now - STALE_RUN_MS}
				)
				RETURNING id, trigger, lesson_id AS lessonId, status, step, error, screenshot,
					started_at AS startedAt, finished_at AS finishedAt`,
		)
		.pipe(Effect.orDie);
	const [row] = inserted;
	if (!row) {
		return yield* new RunAlreadyActive();
	}
	yield* Effect.tryPromise(() =>
		env.RUN_WORKFLOW.create({
			id: runId,
			params: { runId, trigger, lessonId } satisfies RunParams,
		}),
	).pipe(
		Effect.tapError(() =>
			finishRun(runId, { status: "failed", error: "작업을 시작하지 못했어요" }),
		),
		Effect.orDie,
	);
	return toApiRun(row);
});
