import { Duration, Effect, Match, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Command, Http } from "foldkit";
import { Api } from "../shared/api";
import { ApiFailure, Message, type UnlockFailure } from "./message";

const makeClient = HttpApiClient.make(Api, {
	transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(location.origin)),
});

type Client = Effect.Success<typeof makeClient>;

const describeError = (error: unknown): string =>
	Match.value(Predicate.hasProperty(error, "_tag") ? String(error._tag) : "").pipe(
		Match.when("RunAlreadyActive", () => "이미 가져오는 중이에요."),
		Match.when("LessonBusy", () => "지금은 이 수업을 변경할 수 없어요."),
		Match.when("LessonNotFound", () => "이 수업은 더 이상 없어요."),
		Match.orElse(() =>
			Predicate.hasProperty(error, "message") && typeof error.message === "string" && error.message
				? `요청 실패: ${error.message}`
				: "요청에 실패했어요. 연결을 확인하고 다시 시도하세요.",
		),
	);

const toApiFailure = (error: unknown): ApiFailure =>
	Predicate.isTagged(error, "Unauthorized")
		? ApiFailure.Unauthorized()
		: ApiFailure.Failed({ error: describeError(error) });

const callApi = <A, E, Success extends Message, Failure extends Message>(
	request: (client: Client) => Effect.Effect<A, E>,
	onSuccess: (value: A) => Success,
	onFailure: (failure: ApiFailure) => Failure,
): Effect.Effect<Success | Failure> =>
	makeClient.pipe(
		Effect.flatMap(request),
		Effect.map(onSuccess),
		Effect.catch((error) => Effect.succeed(onFailure(toApiFailure(error)))),
		Effect.provide(Http.layer),
	);

export const CheckSession = Command.define("CheckSession", {
	messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
	execute: callApi(
		(client) => client.authorizedSession.check(),
		() => Message.SucceededCheckSession(),
		(failure) => Message.FailedCheckSession({ failure }),
	),
});

const toUnlockFailure = (error: unknown): UnlockFailure =>
	Predicate.isTagged(error, "WrongPattern")
		? "WrongPattern"
		: Predicate.isTagged(error, "TooManyAttempts")
			? "TooManyAttempts"
			: "Network";

export const Unlock = Command.define("Unlock", {
	args: { pattern: Schema.String },
	messages: [Message.SucceededUnlock, Message.FailedUnlock],
	execute: ({ pattern }) =>
		makeClient.pipe(
			Effect.flatMap((client) => client.session.unlock({ payload: { pattern } })),
			Effect.as(Message.SucceededUnlock()),
			Effect.catch((error) =>
				Effect.succeed(Message.FailedUnlock({ failure: toUnlockFailure(error) })),
			),
			Effect.provide(Http.layer),
		),
});

export const WaitBeforeResetPattern = Command.define("WaitBeforeResetPattern", {
	messages: [Message.CompletedWaitBeforeResetPattern],
	execute: Effect.sleep(Duration.millis(900)).pipe(
		Effect.as(Message.CompletedWaitBeforeResetPattern()),
	),
});

export const LoadFirstPage = Command.define("LoadFirstPage", {
	messages: [Message.SucceededLoadFirstPage, Message.FailedLoadFirstPage],
	execute: callApi(
		(client) => client.lessons.list({ query: {} }),
		(page) => Message.SucceededLoadFirstPage({ page }),
		(failure) => Message.FailedLoadFirstPage({ failure }),
	),
});

export const LoadMoreLessons = Command.define("LoadMoreLessons", {
	args: { cursor: Schema.String },
	messages: [Message.SucceededLoadMoreLessons, Message.FailedLoadMoreLessons],
	execute: ({ cursor }) =>
		callApi(
			(client) => client.lessons.list({ query: { cursor } }),
			(page) => Message.SucceededLoadMoreLessons({ page }),
			(failure) => Message.FailedLoadMoreLessons({ failure }),
		),
});

export const LoadStatus = Command.define("LoadStatus", {
	messages: [Message.SucceededLoadStatus, Message.FailedLoadStatus],
	execute: callApi(
		(client) => client.runs.status(),
		(status) => Message.SucceededLoadStatus({ status }),
		(failure) => Message.FailedLoadStatus({ failure }),
	),
});

export const StartRun = Command.define("StartRun", {
	messages: [Message.SucceededStartRun, Message.FailedStartRun],
	execute: callApi(
		(client) => client.runs.start(),
		(run) => Message.SucceededStartRun({ run }),
		(failure) => Message.FailedStartRun({ failure }),
	),
});

export const RetryLesson = Command.define("RetryLesson", {
	args: { lessonId: Schema.String },
	messages: [Message.SucceededRetryLesson, Message.FailedRetryLesson],
	execute: ({ lessonId }) =>
		callApi(
			(client) => client.lessons.retry({ params: { id: lessonId } }),
			(run) => Message.SucceededRetryLesson({ lessonId, run }),
			(failure) => Message.FailedRetryLesson({ lessonId, failure }),
		),
});

export const DeleteLesson = Command.define("DeleteLesson", {
	args: { lessonId: Schema.String },
	messages: [Message.SucceededDeleteLesson, Message.FailedDeleteLesson],
	execute: ({ lessonId }) =>
		callApi(
			(client) => client.lessons.remove({ params: { id: lessonId } }),
			() => Message.SucceededDeleteLesson({ lessonId }),
			(failure) => Message.FailedDeleteLesson({ lessonId, failure }),
		),
});
