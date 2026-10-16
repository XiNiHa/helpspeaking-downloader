import { Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
} from "effect/http-api";

export const LessonStatus = Schema.Literals([
	"queued",
	"processing",
	"ready",
	"failed",
	"expired",
	"deleted",
]);
export type LessonStatus = typeof LessonStatus.Type;

export const LessonPhase = Schema.Literals(["downloading", "probing", "transcoding", "uploading"]);
export type LessonPhase = typeof LessonPhase.Type;

export const Lesson = Schema.Struct({
	id: Schema.String,
	tutor: Schema.OptionFromNullOr(Schema.String),
	status: LessonStatus,
	url: Schema.OptionFromNullOr(Schema.String),
	size: Schema.OptionFromNullOr(Schema.Number),
	duration: Schema.OptionFromNullOr(Schema.Number),
	phase: Schema.OptionFromNullOr(LessonPhase),
	progress: Schema.OptionFromNullOr(Schema.Number),
	phaseStartedAt: Schema.OptionFromNullOr(Schema.Number),
	error: Schema.OptionFromNullOr(Schema.String),
});
export type Lesson = typeof Lesson.Type;

export const LessonPage = Schema.Struct({
	lessons: Schema.Array(Lesson),
	nextCursor: Schema.OptionFromNullOr(Schema.String),
});
export type LessonPage = typeof LessonPage.Type;

export const RunTrigger = Schema.Literals(["cron", "button", "retry"]);
export type RunTrigger = typeof RunTrigger.Type;

export const RunStatus = Schema.Literals(["running", "succeeded", "failed"]);
export type RunStatus = typeof RunStatus.Type;

export const Run = Schema.Struct({
	id: Schema.String,
	trigger: RunTrigger,
	lessonId: Schema.OptionFromNullOr(Schema.String),
	status: RunStatus,
	step: Schema.OptionFromNullOr(Schema.String),
	error: Schema.OptionFromNullOr(Schema.String),
	screenshot: Schema.OptionFromNullOr(Schema.String),
	startedAt: Schema.Number,
	finishedAt: Schema.OptionFromNullOr(Schema.Number),
});
export type Run = typeof Run.Type;

export const Status = Schema.Struct({
	run: Schema.OptionFromNullOr(Run),
});
export type Status = typeof Status.Type;

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Unauthorized",
	{},
	{ httpApiStatus: 401 },
) {}

export class WrongPattern extends Schema.TaggedError<WrongPattern>()(
	"WrongPattern",
	{},
	{ httpApiStatus: 403 },
) {}

export class TooManyAttempts extends Schema.TaggedError<TooManyAttempts>()(
	"TooManyAttempts",
	{},
	{ httpApiStatus: 429 },
) {}

export class RunAlreadyActive extends Schema.TaggedError<RunAlreadyActive>()(
	"RunAlreadyActive",
	{},
	{ httpApiStatus: 409 },
) {}

export class LessonNotFound extends Schema.TaggedError<LessonNotFound>()(
	"LessonNotFound",
	{},
	{ httpApiStatus: 404 },
) {}

export class LessonBusy extends Schema.TaggedError<LessonBusy>()(
	"LessonBusy",
	{ status: LessonStatus },
	{ httpApiStatus: 409 },
) {}

export const sessionSecurity = HttpApiSecurity.apiKey({ key: "session", in: "cookie" });

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
	"helpspeaking/Authorization",
	{ security: { session: sessionSecurity }, error: Unauthorized },
) {}

export class SessionApi extends HttpApiGroup.make("session").add(
	HttpApiEndpoint.post("unlock", "/unlock", {
		payload: Schema.Struct({ pattern: Schema.String }),
		success: HttpApiSchema.NoContent,
		error: [WrongPattern, TooManyAttempts],
	}),
) {}

export class AuthorizedSessionApi extends HttpApiGroup.make("authorizedSession")
	.add(HttpApiEndpoint.get("check", "/session", { success: HttpApiSchema.NoContent }))
	.middleware(Authorization) {}

export class LessonsApi extends HttpApiGroup.make("lessons")
	.add(
		HttpApiEndpoint.get("list", "/lessons", {
			query: { cursor: Schema.optional(Schema.String) },
			success: LessonPage,
		}),
		HttpApiEndpoint.post("retry", "/lessons/:id/retry", {
			params: { id: Schema.String },
			success: Run,
			error: [LessonNotFound, LessonBusy, RunAlreadyActive],
		}),
		HttpApiEndpoint.delete("remove", "/lessons/:id", {
			params: { id: Schema.String },
			success: HttpApiSchema.NoContent,
			error: [LessonNotFound, LessonBusy],
		}),
		HttpApiEndpoint.get("download", "/lessons/:id/download", {
			params: { id: Schema.String },
			error: LessonNotFound,
		}),
	)
	.middleware(Authorization) {}

export class RunsApi extends HttpApiGroup.make("runs")
	.add(
		HttpApiEndpoint.get("status", "/status", { success: Status }),
		HttpApiEndpoint.post("start", "/runs", { success: Run, error: RunAlreadyActive }),
	)
	.middleware(Authorization) {}

export class Api extends HttpApi.make("helpspeaking")
	.add(SessionApi)
	.add(AuthorizedSessionApi)
	.add(LessonsApi)
	.add(RunsApi)
	.prefix("/api") {}

export const downloadPath = (id: string): string =>
	`/api/lessons/${encodeURIComponent(id)}/download`;
