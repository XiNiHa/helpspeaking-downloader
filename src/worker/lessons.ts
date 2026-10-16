import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { lessons } from "../db/schema";
import type { Lesson, LessonPage, LessonPhase } from "../shared/api";
import { lessonObjectFileName } from "../shared/lesson";
import { toBase64Url } from "./base64url";
import { Db } from "./db";

export type LessonRow = typeof lessons.$inferSelect;

const PAGE_SIZE = 30;

export const makeObjectKey = (id: string) =>
	`${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}/${lessonObjectFileName(id)}`;

export const toApiLesson = (row: LessonRow): Lesson => ({
	id: row.id,
	tutor: Option.fromNullOr(row.tutor),
	status: row.status,
	url:
		row.status === "ready" ? Option.some(`${env.MEDIA_BASE_URL}/${row.objectKey}`) : Option.none(),
	size: Option.fromNullOr(row.size),
	duration: Option.fromNullOr(row.duration),
	phase: Option.fromNullOr(row.phase),
	progress: Option.fromNullOr(row.progress),
	phaseStartedAt: Option.fromNullOr(row.phaseStartedAt),
	error: Option.fromNullOr(row.error),
});

export const listLessons = Effect.fn("listLessons")(function* (cursor: string | undefined) {
	const db = yield* Db;
	const rows = yield* db
		.select()
		.from(lessons)
		.where(
			and(ne(lessons.status, "deleted"), cursor === undefined ? undefined : lt(lessons.id, cursor)),
		)
		.orderBy(desc(lessons.id))
		.limit(PAGE_SIZE + 1);
	const page = rows.slice(0, PAGE_SIZE);
	return {
		lessons: page.map(toApiLesson),
		nextCursor: rows.length > PAGE_SIZE ? Option.fromUndefinedOr(page.at(-1)?.id) : Option.none(),
	} satisfies LessonPage;
}, Effect.orDie);

export const findLesson = Effect.fn("findLesson")(function* (id: string) {
	const db = yield* Db;
	const [row] = yield* db.select().from(lessons).where(eq(lessons.id, id)).limit(1);
	return Option.fromUndefinedOr(row);
}, Effect.orDie);

export const findLessons = Effect.fn("findLessons")(function* (ids: ReadonlyArray<string>) {
	if (ids.length === 0) {
		return [];
	}
	const db = yield* Db;
	return yield* db
		.select()
		.from(lessons)
		.where(inArray(lessons.id, [...ids]));
}, Effect.orDie);

export const insertLesson = Effect.fn("insertLesson")(function* (lesson: {
	id: string;
	tutor: string | null;
	objectKey: string;
}) {
	const db = yield* Db;
	const now = Date.now();
	yield* db
		.insert(lessons)
		.values({ ...lesson, status: "queued", createdAt: now, updatedAt: now })
		.onConflictDoNothing();
}, Effect.orDie);

type LessonPatch = Partial<Omit<LessonRow, "id" | "createdAt" | "updatedAt">>;

export const updateLesson = Effect.fn("updateLesson")(function* (id: string, patch: LessonPatch) {
	const db = yield* Db;
	yield* db
		.update(lessons)
		.set({ ...patch, updatedAt: Date.now() })
		.where(eq(lessons.id, id));
}, Effect.orDie);

const clearedProgress = { phase: null, progress: null, phaseStartedAt: null } satisfies LessonPatch;

export const markQueued = (id: string) =>
	updateLesson(id, { status: "queued", error: null, ...clearedProgress });

export const markProgress = Effect.fn("markProgress")(function* (
	id: string,
	phase: LessonPhase,
	progress: number | null,
) {
	const db = yield* Db;
	const now = Date.now();
	yield* db
		.update(lessons)
		.set({
			status: "processing",
			phase,
			progress,
			phaseStartedAt: sql`CASE WHEN ${lessons.phase} = ${phase} THEN ${lessons.phaseStartedAt} ELSE ${now} END`,
			updatedAt: now,
		})
		.where(eq(lessons.id, id));
}, Effect.orDie);

export const markReady = (id: string, result: { size: number; duration: number }) =>
	updateLesson(id, { status: "ready", ...result, error: null, ...clearedProgress });

export const markFailed = (id: string, error: string) =>
	updateLesson(id, { status: "failed", error, ...clearedProgress });

export const markExpired = (id: string) =>
	updateLesson(id, {
		status: "expired",
		error: "저장하기 전에 언어발전소에서 만료됐어요",
		...clearedProgress,
	});

export const markDeleted = (id: string) =>
	updateLesson(id, { status: "deleted", ...clearedProgress });
