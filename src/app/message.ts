import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { LessonPage, Run, Status } from "../shared/api";

export const ApiFailure = defineTaggedUnion({
	Unauthorized: {},
	Failed: { error: Schema.String },
});
export type ApiFailure = typeof ApiFailure.Type;

export const UnlockFailure = Schema.Literals(["WrongPattern", "TooManyAttempts", "Network"]);
export type UnlockFailure = typeof UnlockFailure.Type;

export const Message = defineMessageUnion({
	SucceededCheckSession: {},
	FailedCheckSession: { failure: ApiFailure },

	PressedPattern: { x: Schema.Number, y: Schema.Number },
	MovedPatternPointer: { x: Schema.Number, y: Schema.Number },
	ReleasedPattern: {},
	SucceededUnlock: {},
	FailedUnlock: { failure: UnlockFailure },
	CompletedWaitBeforeResetPattern: {},

	SucceededLoadFirstPage: { page: LessonPage },
	SucceededLoadMoreLessons: { page: LessonPage },
	FailedLoadFirstPage: { failure: ApiFailure },
	FailedLoadMoreLessons: { failure: ApiFailure },
	ClickedLoadMore: {},

	TickedPoll: { now: Schema.Number },
	SucceededLoadStatus: { status: Status },
	FailedLoadStatus: { failure: ApiFailure },

	ClickedRun: {},
	SucceededStartRun: { run: Run },
	FailedStartRun: { failure: ApiFailure },

	ClickedRetry: { lessonId: Schema.String },
	SucceededRetryLesson: { lessonId: Schema.String, run: Run },
	FailedRetryLesson: { lessonId: Schema.String, failure: ApiFailure },

	ClickedRowMenu: { lessonId: Schema.String },
	ClickedDelete: { lessonId: Schema.String },
	ClickedCancelDelete: {},
	ClickedConfirmDelete: { lessonId: Schema.String },
	SucceededDeleteLesson: { lessonId: Schema.String },
	FailedDeleteLesson: { lessonId: Schema.String, failure: ApiFailure },

	ToggledErrorDetails: { lessonId: Schema.String, isOpen: Schema.Boolean },
	ToggledScreenshot: { isOpen: Schema.Boolean },
	ClickedDismissNotice: {},
});
export type Message = typeof Message.Type;
