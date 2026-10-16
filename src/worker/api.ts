import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Redacted, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
	Api,
	Authorization,
	LessonBusy,
	LessonNotFound,
	sessionSecurity,
	TooManyAttempts,
	Unauthorized,
	WrongPattern,
} from "../shared/api";
import { lessonDownloadFileName } from "../shared/lesson";
import { Db } from "./db";
import { findLesson, listLessons, markDeleted } from "./lessons";
import { latestRun, startRun } from "./runs";
import { isUnlockLockedOut, recordUnlockFailure } from "./unlock-failures";
import {
	isCorrectPattern,
	isValidSessionToken,
	issueSessionToken,
	SESSION_MAX_AGE,
} from "./session";

const setSessionCookie = Effect.gen(function* () {
	const token = yield* issueSessionToken;
	yield* HttpApiBuilder.securitySetCookie(sessionSecurity, token, {
		path: "/",
		sameSite: "strict",
		maxAge: SESSION_MAX_AGE,
	});
});

const AuthorizationLive = Layer.succeed(
	Authorization,
	Authorization.of({
		session: Effect.fn(function* (httpEffect, { credential }) {
			if (!(yield* isValidSessionToken(Redacted.value(credential)))) {
				return yield* new Unauthorized();
			}
			yield* setSessionCookie;
			return yield* httpEffect;
		}),
	}),
);

const requireLesson = (id: string) =>
	findLesson(id).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(new LessonNotFound()),
				onSome: (lesson) => Effect.succeed(lesson),
			}),
		),
	);

const contentDisposition = (fileName: string) => {
	const asciiFallback = fileName.replace(/[^\x20-\x7e]|"/g, "_");
	const encoded = encodeURIComponent(fileName).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
};

const SessionHandlers = HttpApiBuilder.group(Api, "session", (handlers) =>
	handlers.handle(
		"unlock",
		Effect.fn(function* ({ payload }) {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const { success } = yield* Effect.promise(() =>
				env.UNLOCK_LIMITER.limit({ key: request.headers["cf-connecting-ip"] ?? "unknown" }),
			);
			if (!success || (yield* isUnlockLockedOut())) {
				return yield* new TooManyAttempts();
			}
			if (!(yield* isCorrectPattern(payload.pattern))) {
				yield* recordUnlockFailure();
				return yield* new WrongPattern();
			}
			yield* setSessionCookie;
		}),
	),
);

const AuthorizedSessionHandlers = HttpApiBuilder.group(Api, "authorizedSession", (handlers) =>
	handlers.handle("check", () => Effect.void),
);

const LessonsHandlers = HttpApiBuilder.group(Api, "lessons", (handlers) =>
	handlers.handleAll({
		list: ({ query }) => listLessons(query.cursor),
		retry: Effect.fn(function* ({ params }) {
			const lesson = yield* requireLesson(params.id);
			if (lesson.status !== "failed") {
				return yield* new LessonBusy({ status: lesson.status });
			}
			return yield* startRun("retry", lesson.id);
		}),
		remove: Effect.fn(function* ({ params }) {
			const lesson = yield* requireLesson(params.id);
			if (lesson.status === "queued" || lesson.status === "processing") {
				return yield* new LessonBusy({ status: lesson.status });
			}
			if (lesson.status === "ready") {
				yield* Effect.promise(() => env.MEDIA.delete(lesson.objectKey));
			}
			yield* markDeleted(lesson.id);
		}),
		download: Effect.fn(function* ({ params }) {
			const lesson = yield* requireLesson(params.id);
			const object =
				lesson.status === "ready"
					? yield* Effect.promise(() => env.MEDIA.get(lesson.objectKey))
					: null;
			if (!object) {
				return yield* new LessonNotFound();
			}
			return HttpServerResponse.raw(object.body, {
				contentType: "video/mp4",
				contentLength: object.size,
				headers: {
					"content-disposition": contentDisposition(
						lessonDownloadFileName(lesson.id, lesson.tutor),
					),
				},
			});
		}),
	}),
);

const RunsHandlers = HttpApiBuilder.group(Api, "runs", (handlers) =>
	handlers.handleAll({
		status: () => latestRun.pipe(Effect.map((run) => ({ run }))),
		start: () => startRun("button"),
	}),
);

const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

export const { handler: apiHandler } = HttpRouter.toWebHandler(
	HttpApiBuilder.layer(Api).pipe(
		Layer.provide([SessionHandlers, AuthorizedSessionHandlers, LessonsHandlers, RunsHandlers]),
		Layer.provide(AuthorizationLive),
		HttpRouter.provideRequest(Db.layer),
		Layer.provide(HttpServer.layerServices),
		Layer.provideMerge(SyncScheduler),
	),
);
