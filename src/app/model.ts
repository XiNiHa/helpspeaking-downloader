import { Clock, Effect, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";
import { Lesson, Run } from "../shared/api";

export const Flags = Schema.Struct({ isAndroid: Schema.Boolean, now: Schema.Number });
export type Flags = typeof Flags.Type;

export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis;
	return Flags.make({ isAndroid: /Android/i.test(navigator.userAgent), now });
});

export const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export type Point = typeof Point.Type;

export const LockStatus = defineTaggedUnion({
	Idle: {},
	Drawing: {},
	Verifying: {},
	Rejected: { reason: Schema.String },
});
export type LockStatus = typeof LockStatus.Type;

export const Lock = Schema.Struct({
	dots: Schema.Array(Schema.Number),
	maybePointer: Schema.Option(Point),
	status: LockStatus,
});
export type Lock = typeof Lock.Type;

export const LessonList = defineTaggedUnion({
	Loading: {},
	Loaded: {
		lessons: Schema.Array(Lesson),
		maybeNextCursor: Schema.Option(Schema.String),
		isLoadingMore: Schema.Boolean,
	},
	LoadFailed: { error: Schema.String },
});
export type LessonList = typeof LessonList.Type;

export const RowMode = defineTaggedUnion({
	Closed: {},
	MenuOpen: { lessonId: Schema.String },
	ConfirmingDelete: { lessonId: Schema.String },
});
export type RowMode = typeof RowMode.Type;

export const Library = Schema.Struct({
	lessons: LessonList,
	maybeRun: Schema.Option(Run),
	isStartingRun: Schema.Boolean,
	rowMode: RowMode,
	busyLessonIds: Schema.Array(Schema.String),
	expandedErrorIds: Schema.Array(Schema.String),
	isScreenshotOpen: Schema.Boolean,
	maybeNotice: Schema.Option(Schema.String),
});
export type Library = typeof Library.Type;

export const Screen = defineTaggedUnion({
	CheckingSession: {},
	Locked: { lock: Lock },
	Unlocked: { library: Library },
});
export type Screen = typeof Screen.Type;

export const Model = Schema.Struct({
	isAndroid: Schema.Boolean,
	now: Schema.Number,
	screen: Screen,
});
export type Model = typeof Model.Type;
