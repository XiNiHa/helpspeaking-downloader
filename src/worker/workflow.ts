import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Option } from "effect";
import type { LessonStatus } from "../shared/api";
import { lessonLabel } from "../shared/lesson";
import { Db } from "./db";
import { type LessonVideoSource, type ScrapedLesson, scrapeRecentLessons } from "./helpspeaking";
import {
	findLesson,
	findLessons,
	insertLesson,
	makeObjectKey,
	markExpired,
	markFailed,
	markProgress,
	markQueued,
	markReady,
} from "./lessons";
import { sendAlert } from "./mail";
import { findRunScreenshot, finishRun, type RunParams, updateRun } from "./runs";
import type { TranscodeState } from "./transcoder";

const MAX_ATTEMPTS = 3;
const MAX_POLLS_PER_ATTEMPT = 360;
const POLL_INTERVAL = "10 seconds";
const BACKOFF = ["1 minute", "5 minutes"] as const;

interface PlannedLesson {
	readonly id: string;
	readonly objectKey: string;
	readonly video: LessonVideoSource;
}

interface Plan {
	readonly toProcess: ReadonlyArray<PlannedLesson>;
	readonly expired: ReadonlyArray<string>;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const runEffect = <A, E>(effect: Effect.Effect<A, E, Db>): Promise<A> =>
	Effect.runPromise(effect.pipe(Effect.provide(Db.layer)));

const EXPIRABLE_STATUSES: ReadonlySet<LessonStatus> = new Set(["queued", "processing", "failed"]);

// Failed lessons are only picked up again by a manual retry, which scopes the run to them.
const processableStatuses = (only: string | null): ReadonlySet<LessonStatus> =>
	new Set(["queued", "processing", "expired", ...(only === null ? [] : ["failed" as const])]);

const plan = Effect.fn("plan")(function* (
	scraped: ReadonlyArray<ScrapedLesson>,
	only: string | null,
) {
	const candidates = only === null ? scraped : scraped.filter((lesson) => lesson.id === only);
	const rows = new Map(
		(yield* findLessons([...candidates.map((lesson) => lesson.id), ...(only ? [only] : [])])).map(
			(row) => [row.id, row],
		),
	);
	const processable = processableStatuses(only);
	const toProcess: PlannedLesson[] = [];
	const expired: string[] = [];
	const expire = Effect.fn("plan.expire")(function* (id: string) {
		const status = rows.get(id)?.status;
		if (status && EXPIRABLE_STATUSES.has(status)) {
			yield* markExpired(id);
			expired.push(id);
		}
	});

	if (only !== null && candidates.length === 0) {
		yield* expire(only);
	}
	for (const lesson of candidates) {
		const row = rows.get(lesson.id);
		if (!lesson.video) {
			yield* expire(lesson.id);
			continue;
		}
		if (!row) {
			const objectKey = makeObjectKey(lesson.id);
			yield* insertLesson({ id: lesson.id, tutor: lesson.tutor, objectKey });
			toProcess.push({ id: lesson.id, objectKey, video: lesson.video });
		} else if (processable.has(row.status)) {
			yield* markQueued(lesson.id);
			toProcess.push({ id: lesson.id, objectKey: row.objectKey, video: lesson.video });
		}
	}
	return { toProcess, expired } satisfies Plan;
});

export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
	async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
		const { runId, lessonId } = event.payload;
		try {
			await step.do("mark checking", () =>
				runEffect(updateRun(runId, { step: "언어발전소 확인 중" })),
			);
			const scraped = await step.do(
				"scrape",
				{
					retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
					timeout: "5 minutes",
					sensitive: "output",
				},
				() =>
					runEffect(
						scrapeRecentLessons.pipe(
							Effect.tapError((error) =>
								updateRun(runId, { screenshot: error.screenshot ?? null }),
							),
							Effect.mapError((error) => new Error(`${error.step}: ${error.message}`)),
						),
					),
			);
			const { toProcess, expired } = await step.do("plan", { sensitive: "output" }, () =>
				runEffect(plan(scraped, lessonId)),
			);
			await step.do("alert expired", () =>
				runEffect(
					Effect.forEach(expired, (id) =>
						sendAlert({
							subject: `Lesson ${lessonLabel(id)} expired`,
							lines: ["The video expired on helpspeaking before it could be saved."],
						}),
					),
				),
			);
			for (const [index, lesson] of toProcess.entries()) {
				await step.do(`mark processing ${lesson.id}`, () =>
					runEffect(
						updateRun(runId, {
							step: `${lessonLabel(lesson.id)} 처리 중 (${index + 1}/${toProcess.length})`,
						}),
					),
				);
				try {
					await this.processLesson(step, runId, lesson);
				} catch (error) {
					await this.failLesson(step, runId, `abort ${lesson.id}`, lesson.id, errorMessage(error));
				}
			}
			await step.do("finish", () => runEffect(finishRun(runId, { status: "succeeded" })));
		} catch (error) {
			const message = errorMessage(error);
			await step.do("fail", () =>
				runEffect(
					Effect.gen(function* () {
						yield* finishRun(runId, { status: "failed", error: message });
						const screenshot = yield* findRunScreenshot(runId);
						yield* sendAlert({ subject: "Run failed", lines: [`Error: ${message}`], screenshot });
					}),
				),
			);
		}
	}

	private async processLesson(step: WorkflowStep, runId: string, lesson: PlannedLesson) {
		const transcoder = this.env.TRANSCODER.getByName(lesson.id);
		let lastError = "변환에 실패했어요";
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const jobId = `${runId}#${attempt}`;
			const tag = `${lesson.id} #${attempt}`;
			const isStarted = await step.do(`start ${tag}`, async () => {
				const started = await transcoder.start({
					runId,
					jobId,
					sourceUrl: lesson.video.url,
					sourceHeaders: lesson.video.headers,
					objectKey: lesson.objectKey,
				});
				if (started) {
					await runEffect(markProgress(lesson.id, "downloading", null));
				}
				return started;
			});
			if (!isStarted) {
				return;
			}

			let state: TranscodeState = { phase: "idle" };
			for (let poll = 0; poll < MAX_POLLS_PER_ATTEMPT; poll++) {
				await step.sleep(`wait ${tag}.${poll}`, POLL_INTERVAL);
				state = await step.do(`poll ${tag}.${poll}`, async () => {
					const current: TranscodeState = await transcoder.status(jobId);
					if (current.phase !== "idle" && current.phase !== "done" && current.phase !== "failed") {
						await runEffect(markProgress(lesson.id, current.phase, current.progress));
					}
					return current;
				});
				if (state.phase === "done" || state.phase === "failed" || state.phase === "idle") {
					break;
				}
			}

			if (state.phase === "done") {
				const result = { size: state.size, duration: state.duration };
				await step.do(`finish ${tag}`, async () => {
					await runEffect(markReady(lesson.id, result));
					await transcoder.stop(runId);
				});
				return;
			}

			lastError =
				state.phase === "failed"
					? state.error
					: state.phase === "idle"
						? "변환 작업의 상태를 잃어버렸어요"
						: "변환 시간이 초과됐어요";
			await step.do(`stop ${tag}`, async () => {
				await transcoder.stop(runId);
				await runEffect(markQueued(lesson.id));
			});
			const backoff = BACKOFF[attempt - 1];
			if (backoff) {
				await step.sleep(`backoff ${tag}`, backoff);
			}
		}

		await this.failLesson(
			step,
			runId,
			`fail ${lesson.id}`,
			lesson.id,
			`${lastError} (${MAX_ATTEMPTS}번 시도 후 중단)`,
		);
	}

	private async failLesson(
		step: WorkflowStep,
		runId: string,
		name: string,
		lessonId: string,
		error: string,
	) {
		await step.do(name, async () => {
			await this.env.TRANSCODER.getByName(lessonId).stop(runId);
			await runEffect(
				Effect.gen(function* () {
					const row = yield* findLesson(lessonId);
					if (Option.exists(row, ({ status }) => status === "deleted")) {
						return;
					}
					yield* markFailed(lessonId, error);
					yield* sendAlert({
						subject: `Lesson ${lessonLabel(lessonId)} failed`,
						lines: [`Error: ${error}`],
					});
				}),
			);
		});
	}
}
