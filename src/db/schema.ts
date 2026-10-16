import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { LessonPhase, LessonStatus, RunStatus, RunTrigger } from "../shared/api";

export const lessons = sqliteTable(
	"lessons",
	{
		id: text("id").primaryKey(),
		tutor: text("tutor"),
		status: text("status").$type<LessonStatus>().notNull(),
		objectKey: text("object_key").notNull(),
		size: integer("size"),
		duration: real("duration"),
		phase: text("phase").$type<LessonPhase>(),
		progress: real("progress"),
		phaseStartedAt: integer("phase_started_at"),
		error: text("error"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("lessons_status_idx").on(table.status)],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		trigger: text("trigger").$type<RunTrigger>().notNull(),
		lessonId: text("lesson_id"),
		status: text("status").$type<RunStatus>().notNull(),
		step: text("step"),
		error: text("error"),
		screenshot: text("screenshot"),
		startedAt: integer("started_at").notNull(),
		finishedAt: integer("finished_at"),
	},
	(table) => [index("runs_started_at_idx").on(table.startedAt)],
);
