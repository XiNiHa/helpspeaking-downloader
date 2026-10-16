import { Array, Match, Option, Stream } from "effect";
import { Dom, Mount } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { downloadPath, type Lesson, type LessonPhase, type Run } from "../shared/api";
import { lessonDownloadFileName, parseLessonId } from "../shared/lesson";
import { Message } from "./message";
import {
	type Library,
	LessonList,
	type Lock,
	LockStatus,
	type Model,
	type Point,
	RowMode,
	Screen,
} from "./model";
import { allDots, dotCenter } from "./pattern";
import { isRunActive } from "./update";

type H = HtmlBuilder<Message>;

// PATTERN LOCK

const PATTERN_VIEWBOX_SIZE = 300;

const TrackPattern = Mount.defineStream("TrackPattern", {
	messages: [Message.PressedPattern, Message.MovedPatternPointer, Message.ReleasedPattern],
	execute: ({ element }) => {
		const target = element as SVGSVGElement;
		const toPoint = (event: PointerEvent) => {
			const rect = target.getBoundingClientRect();
			return {
				x: (event.clientX - rect.left) / rect.width,
				y: (event.clientY - rect.top) / rect.height,
			};
		};
		return Stream.mergeAll(
			[
				Dom.streamFromEventFilterMapPreventDefault({
					target,
					type: "pointerdown",
					filterMapEvent: (event) => {
						target.setPointerCapture(event.pointerId);
						return Option.some(Message.PressedPattern(toPoint(event)));
					},
				}),
				Dom.streamFromEventFilterMapPreventDefault({
					target,
					type: "pointermove",
					filterMapEvent: (event) =>
						event.buttons === 0
							? Option.none()
							: Option.some(Message.MovedPatternPointer(toPoint(event))),
				}),
				Dom.streamFromEventFilterMapPreventDefault({
					target,
					type: "pointerup",
					filterMapEvent: () => Option.some(Message.ReleasedPattern()),
				}),
				Dom.streamFromEventFilterMapPreventDefault({
					target,
					type: "pointercancel",
					filterMapEvent: () => Option.some(Message.ReleasedPattern()),
				}),
			],
			{ concurrency: "unbounded" },
		);
	},
});

const toViewBox = (point: Point) => ({
	x: point.x * PATTERN_VIEWBOX_SIZE,
	y: point.y * PATTERN_VIEWBOX_SIZE,
});

const patternTone = (status: LockStatus) =>
	LockStatus.match(status, {
		Idle: () => "text-sky-600 dark:text-sky-400",
		Drawing: () => "text-sky-600 dark:text-sky-400",
		Verifying: () => "text-zinc-400 dark:text-zinc-500",
		Rejected: () => "text-red-600 dark:text-red-400",
	});

const patternGridView = (lock: Lock, h: H): Html => {
	const points = Array.map(lock.dots, (dot) => toViewBox(dotCenter(dot)));
	const maybeTrail = Option.flatMap(
		Option.filter(lock.maybePointer, () => lock.status._tag === "Drawing"),
		(pointer) => Option.map(Array.last(points), (from) => ({ from, to: toViewBox(pointer) })),
	);
	return h.svg(
		[
			h.ViewBox(`0 0 ${PATTERN_VIEWBOX_SIZE} ${PATTERN_VIEWBOX_SIZE}`),
			h.Class(
				`h-72 w-72 touch-none select-none ${patternTone(lock.status)} ${lock.status._tag === "Rejected" ? "animate-shake" : ""}`,
			),
			h.Role("img"),
			h.AriaLabel("잠금 해제 패턴"),
			h.OnMount(TrackPattern()),
		],
		[
			h.polyline([
				h.Points(points.map(({ x, y }) => `${x},${y}`).join(" ")),
				h.Fill("none"),
				h.Stroke("currentColor"),
				h.StrokeWidth("6"),
				h.StrokeLinecap("round"),
				h.StrokeLinejoin("round"),
				h.Class("opacity-70"),
			]),
			Option.match(maybeTrail, {
				onNone: () => h.empty,
				onSome: ({ from, to }) =>
					h.line([
						h.X1(String(from.x)),
						h.Y1(String(from.y)),
						h.X2(String(to.x)),
						h.Y2(String(to.y)),
						h.Stroke("currentColor"),
						h.StrokeWidth("6"),
						h.StrokeLinecap("round"),
						h.Class("opacity-40"),
					]),
			}),
			...Array.map(allDots, (dot) => {
				const center = toViewBox(dotCenter(dot));
				const isSelected = lock.dots.includes(dot);
				return h.g(
					[],
					[
						isSelected
							? h.circle([
									h.Cx(String(center.x)),
									h.Cy(String(center.y)),
									h.R("28"),
									h.Fill("currentColor"),
									h.Class("opacity-15"),
								])
							: h.empty,
						h.circle([
							h.Cx(String(center.x)),
							h.Cy(String(center.y)),
							h.R(isSelected ? "11" : "8"),
							h.Class(isSelected ? "fill-current" : "fill-zinc-400 dark:fill-zinc-600"),
						]),
					],
				);
			}),
		],
	);
};

const lockMessage = (status: LockStatus) =>
	LockStatus.match(status, {
		Idle: () => "패턴을 그려 잠금을 해제하세요",
		Drawing: () => "다 그렸으면 손을 떼세요",
		Verifying: () => "확인 중…",
		Rejected: ({ reason }) => reason,
	});

const lockView = (lock: Lock, h: H): Html =>
	h.main(
		[h.Class("flex min-h-dvh flex-col items-center justify-center gap-10 px-4")],
		[
			h.div(
				[h.Class("text-center")],
				[
					h.h1([h.Class("text-2xl font-semibold tracking-tight")], ["언어발전소"]),
					h.p(
						[
							h.Class(
								`mt-2 text-sm ${lock.status._tag === "Rejected" ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}`,
							),
							h.AriaLive("polite"),
						],
						[lockMessage(lock.status)],
					),
				],
			),
			patternGridView(lock, h),
		],
	);

// FORMATTING

const formatLessonDate = (id: string, now: number): string => {
	const parts = parseLessonId(id);
	if (!parts) {
		return id;
	}
	const [year, month, day] = parts.date.split("-").map(Number);
	const date = new Date(Date.UTC(year!, month! - 1, day!));
	return date.toLocaleDateString("ko-KR", {
		weekday: "short",
		month: "long",
		day: "numeric",
		year: year === new Date(now).getFullYear() ? undefined : "numeric",
		timeZone: "UTC",
	});
};

const formatDuration = (seconds: number): string => {
	const minutes = Math.round(seconds / 60);
	return minutes < 60
		? `${minutes}분`
		: `${Math.floor(minutes / 60)}시간 ${String(minutes % 60).padStart(2, "0")}분`;
};

const formatSize = (bytes: number): string =>
	bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: `${Math.round(bytes / 1024 ** 2)} MB`;

const formatTimestamp = (epoch: number): string =>
	new Date(epoch).toLocaleString("ko-KR", {
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

const formatEta = (lesson: Lesson, now: number): Option.Option<string> =>
	Option.flatMap(Option.all([lesson.progress, lesson.phaseStartedAt]), ([progress, startedAt]) => {
		const elapsed = now - startedAt;
		if (progress < 0.02 || elapsed < 5_000) {
			return Option.none();
		}
		const remainingMinutes = Math.max(
			1,
			Math.round((elapsed * (1 - progress)) / progress / 60_000),
		);
		return Option.some(`약 ${remainingMinutes}분 남음`);
	});

const phaseLabel = (phase: LessonPhase): string =>
	Match.value(phase).pipe(
		Match.when("downloading", () => "다운로드 중"),
		Match.when("probing", () => "형식 확인 중"),
		Match.when("transcoding", () => "변환 중"),
		Match.when("uploading", () => "업로드 중"),
		Match.exhaustive,
	);

const triggerLabel = (run: Run): string =>
	Match.value(run.trigger).pipe(
		Match.when("cron", () => "자동"),
		Match.when("button", () => "수동"),
		Match.when("retry", () => "재시도"),
		Match.exhaustive,
	);

const intentUrl = (url: string): string => {
	const parsed = new URL(url);
	return `intent://${parsed.host}${parsed.pathname}#Intent;scheme=${parsed.protocol.replace(":", "")};type=video/mp4;S.browser_fallback_url=${encodeURIComponent(url)};end`;
};

// LIBRARY

const buttonClass = {
	primary:
		"inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500",
	secondary:
		"inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800",
	danger:
		"inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50",
	ghost:
		"inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
} as const;

const spinner = (h: H): Html =>
	h.span([
		h.Class(
			"inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent",
		),
		h.AriaHidden(true),
	]);

const runButtonView = (library: Library, h: H): Html => {
	const isActive = isRunActive(library.maybeRun);
	return h.button(
		[
			h.Type("button"),
			h.Class(buttonClass.primary),
			h.Disabled(library.isStartingRun || isActive),
			h.OnClick(Message.ClickedRun()),
		],
		library.isStartingRun || isActive
			? [spinner(h), library.isStartingRun ? "시작하는 중…" : "가져오는 중…"]
			: ["지금 가져오기"],
	);
};

const runStatusView = (library: Library, h: H): Html =>
	Option.match(library.maybeRun, {
		onNone: () => h.empty,
		onSome: (run) =>
			Match.value(run.status).pipe(
				Match.when("running", () =>
					h.section(
						[
							h.Class(
								"flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100",
							),
							h.AriaLive("polite"),
						],
						[
							h.span([h.Class("mt-0.5")], [spinner(h)]),
							h.div(
								[],
								[
									h.p(
										[h.Class("text-sm font-medium")],
										[Option.getOrElse(run.step, () => "시작하는 중…")],
									),
									h.p(
										[h.Class("text-xs opacity-75")],
										[`${formatTimestamp(run.startedAt)} 시작 · ${triggerLabel(run)}`],
									),
								],
							),
						],
					),
				),
				Match.when("failed", () =>
					h.section(
						[
							h.Class(
								"rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
							),
						],
						[
							h.p(
								[h.Class("text-sm font-medium")],
								[`마지막 실행 실패 · ${formatTimestamp(run.startedAt)} · ${triggerLabel(run)}`],
							),
							h.p(
								[h.Class("mt-1 break-words text-sm opacity-90")],
								[Option.getOrElse(run.error, () => "알 수 없는 오류")],
							),
							Option.match(run.screenshot, {
								onNone: () => h.empty,
								onSome: (screenshot) =>
									h.details(
										[
											h.Class("mt-3"),
											h.Open(library.isScreenshotOpen),
											h.OnToggle((isOpen) => Message.ToggledScreenshot({ isOpen })),
										],
										[
											h.summary([h.Class("cursor-pointer text-sm font-medium")], ["스크린샷"]),
											h.img([
												h.Src(screenshot),
												h.Alt("실패 시점의 브라우저 화면"),
												h.Class("mt-2 w-full rounded-lg border border-red-200 dark:border-red-900"),
											]),
										],
									),
							}),
						],
					),
				),
				Match.when("succeeded", () =>
					h.p(
						[h.Class("text-xs text-zinc-500 dark:text-zinc-400")],
						[
							`마지막 확인 ${formatTimestamp(Option.getOrElse(run.finishedAt, () => run.startedAt))} · ${triggerLabel(run)}`,
						],
					),
				),
				Match.exhaustive,
			),
	});

const noticeView = (library: Library, h: H): Html =>
	Option.match(library.maybeNotice, {
		onNone: () => h.empty,
		onSome: (notice) =>
			h.div(
				[
					h.Class(
						"flex items-start justify-between gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100",
					),
					h.Role("alert"),
				],
				[
					h.p([], [notice]),
					h.button(
						[
							h.Type("button"),
							h.Class("text-xs font-medium underline"),
							h.OnClick(Message.ClickedDismissNotice()),
						],
						["닫기"],
					),
				],
			),
	});

const statusBadge = (lesson: Lesson, h: H): Html => {
	const [label, tone] = Match.value(lesson.status).pipe(
		Match.withReturnType<readonly [string, string]>(),
		Match.when("queued", () => [
			"대기 중",
			"bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200",
		]),
		Match.when("processing", () => [
			"처리 중",
			"bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200",
		]),
		Match.when("ready", () => [
			"준비됨",
			"bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
		]),
		Match.when("failed", () => [
			"실패",
			"bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200",
		]),
		Match.when("expired", () => [
			"만료됨",
			"bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
		]),
		Match.when("deleted", () => [
			"삭제됨",
			"bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
		]),
		Match.exhaustive,
	);
	return h.span(
		[h.Class(`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`)],
		[label],
	);
};

const progressView = (lesson: Lesson, now: number, h: H): Html => {
	const phase = Option.getOrElse(lesson.phase, (): LessonPhase => "downloading");
	const maybePercent = Option.filter(lesson.progress, () => phase === "transcoding");
	const details = [
		phaseLabel(phase),
		...Option.toArray(Option.map(maybePercent, (progress) => `${Math.floor(progress * 100)}%`)),
		...Option.toArray(phase === "transcoding" ? formatEta(lesson, now) : Option.none()),
	].join(" · ");
	return h.div(
		[h.Class("mt-3")],
		[
			h.div(
				[h.Class("h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800")],
				[
					Option.match(maybePercent, {
						onNone: () => h.div([h.Class("h-full w-1/3 animate-pulse rounded-full bg-sky-500")]),
						onSome: (progress) =>
							h.div([
								h.Class("h-full rounded-full bg-sky-500 transition-[width] duration-500"),
								h.Style({ width: `${Math.max(2, progress * 100)}%` }),
							]),
					}),
				],
			),
			h.p([h.Class("mt-1.5 text-xs text-zinc-500 dark:text-zinc-400")], [details]),
		],
	);
};

const isMenuOpen = (library: Library, lessonId: string) =>
	library.rowMode._tag === "MenuOpen" && library.rowMode.lessonId === lessonId;

const isConfirmingDelete = (library: Library, lessonId: string) =>
	library.rowMode._tag === "ConfirmingDelete" && library.rowMode.lessonId === lessonId;

const menuButton = (lesson: Lesson, library: Library, h: H): Html =>
	h.button(
		[
			h.Type("button"),
			h.Class(buttonClass.ghost),
			h.AriaLabel("더보기"),
			h.AriaExpanded(isMenuOpen(library, lesson.id)),
			h.OnClick(Message.ClickedRowMenu({ lessonId: lesson.id })),
		],
		["⋯"],
	);

const rowMenuView = (lesson: Lesson, library: Library, h: H): Html =>
	RowMode.match(library.rowMode, {
		Closed: () => h.empty,
		MenuOpen: ({ lessonId }) =>
			lessonId === lesson.id
				? h.div(
						[h.Class("mt-3 flex justify-end")],
						[
							h.button(
								[
									h.Type("button"),
									h.Class(`${buttonClass.secondary} text-red-600 dark:text-red-400`),
									h.OnClick(Message.ClickedDelete({ lessonId: lesson.id })),
								],
								["삭제"],
							),
						],
					)
				: h.empty,
		ConfirmingDelete: ({ lessonId }) =>
			lessonId === lesson.id
				? h.div(
						[
							h.Class(
								"mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 p-3 dark:bg-red-950",
							),
						],
						[
							h.p(
								[h.Class("text-sm text-red-900 dark:text-red-100")],
								["이 수업을 삭제할까요? 되돌릴 수 없어요."],
							),
							h.div(
								[h.Class("flex gap-2")],
								[
									h.button(
										[
											h.Type("button"),
											h.Class(buttonClass.secondary),
											h.OnClick(Message.ClickedCancelDelete()),
										],
										["취소"],
									),
									h.button(
										[
											h.Type("button"),
											h.Class(buttonClass.danger),
											h.OnClick(Message.ClickedConfirmDelete({ lessonId: lesson.id })),
										],
										["삭제"],
									),
								],
							),
						],
					)
				: h.empty,
	});

const lessonBodyView = (model: Model, library: Library, lesson: Lesson, h: H): Html => {
	const isBusy = library.busyLessonIds.includes(lesson.id);
	return Match.value(lesson.status).pipe(
		Match.when("queued", () =>
			h.p([h.Class("mt-3 text-xs text-zinc-500 dark:text-zinc-400")], ["시작 대기 중…"]),
		),
		Match.when("processing", () => progressView(lesson, model.now, h)),
		Match.when("ready", () =>
			Option.match(lesson.url, {
				onNone: () => h.empty,
				onSome: (url) =>
					h.div(
						[h.Class("mt-3 flex items-center gap-2")],
						[
							h.a(
								[
									h.Href(model.isAndroid ? intentUrl(url) : url),
									h.Class(buttonClass.primary),
									...(model.isAndroid ? [] : [h.Target("_blank"), h.Rel("noopener")]),
								],
								["▶ 재생"],
							),
							h.a(
								[
									h.Href(downloadPath(lesson.id)),
									h.Download(lessonDownloadFileName(lesson.id, Option.getOrNull(lesson.tutor))),
									h.Class(buttonClass.secondary),
								],
								["다운로드"],
							),
							h.span([h.Class("flex-1")]),
							menuButton(lesson, library, h),
						],
					),
			}),
		),
		Match.when("failed", () =>
			h.div(
				[h.Class("mt-3")],
				[
					h.details(
						[
							h.Open(library.expandedErrorIds.includes(lesson.id)),
							h.OnToggle((isOpen) => Message.ToggledErrorDetails({ lessonId: lesson.id, isOpen })),
						],
						[
							h.summary(
								[h.Class("cursor-pointer text-sm text-red-700 dark:text-red-300")],
								["오류 보기"],
							),
							h.p(
								[h.Class("mt-1 break-words font-mono text-xs text-red-800 dark:text-red-200")],
								[Option.getOrElse(lesson.error, () => "알 수 없는 오류")],
							),
						],
					),
					h.div(
						[h.Class("mt-3 flex items-center gap-2")],
						[
							h.button(
								[
									h.Type("button"),
									h.Class(buttonClass.secondary),
									h.Disabled(isBusy || isRunActive(library.maybeRun)),
									h.OnClick(Message.ClickedRetry({ lessonId: lesson.id })),
								],
								isBusy ? [spinner(h), "다시 시도하는 중…"] : ["다시 시도"],
							),
							h.span([h.Class("flex-1")]),
							menuButton(lesson, library, h),
						],
					),
				],
			),
		),
		Match.when("expired", () =>
			h.div(
				[h.Class("mt-3 flex items-center gap-2")],
				[
					h.p(
						[h.Class("flex-1 text-xs text-zinc-500 dark:text-zinc-400")],
						[Option.getOrElse(lesson.error, () => "저장하기 전에 언어발전소에서 만료됐어요")],
					),
					menuButton(lesson, library, h),
				],
			),
		),
		Match.when("deleted", () => h.empty),
		Match.exhaustive,
	);
};

const lessonCardView = (model: Model, library: Library, lesson: Lesson, h: H): Html => {
	const parts = parseLessonId(lesson.id);
	const meta = [
		...Option.toArray(lesson.tutor),
		...Option.toArray(Option.map(lesson.duration, formatDuration)),
		...Option.toArray(Option.map(lesson.size, formatSize)),
	].join(" · ");
	return h.keyed("li")(
		lesson.id,
		[
			h.Class(
				`rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${lesson.status === "expired" ? "opacity-60" : ""}`,
			),
		],
		[
			h.div(
				[h.Class("flex items-start justify-between gap-3")],
				[
					h.div(
						[h.Class("min-w-0")],
						[
							h.p(
								[h.Class("font-medium")],
								[
									formatLessonDate(lesson.id, model.now),
									parts?.time
										? h.span([h.Class("ml-2 text-zinc-500 dark:text-zinc-400")], [parts.time])
										: h.empty,
								],
							),
							meta
								? h.p([h.Class("mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400")], [meta])
								: h.empty,
						],
					),
					statusBadge(lesson, h),
				],
			),
			lessonBodyView(model, library, lesson, h),
			isMenuOpen(library, lesson.id) || isConfirmingDelete(library, lesson.id)
				? rowMenuView(lesson, library, h)
				: h.empty,
		],
	);
};

const lessonListView = (model: Model, library: Library, h: H): Html =>
	LessonList.match(library.lessons, {
		Loading: () =>
			h.p(
				[h.Class("py-12 text-center text-sm text-zinc-500 dark:text-zinc-400")],
				["수업을 불러오는 중…"],
			),
		LoadFailed: ({ error }) =>
			h.p([h.Class("py-12 text-center text-sm text-red-600 dark:text-red-400")], [error]),
		Loaded: ({ lessons, maybeNextCursor, isLoadingMore }) =>
			Array.match(lessons, {
				onEmpty: () =>
					h.p(
						[h.Class("py-12 text-center text-sm text-zinc-500 dark:text-zinc-400")],
						["아직 수업이 없어요. ‘지금 가져오기’를 눌러 언어발전소를 확인하세요."],
					),
				onNonEmpty: (nonEmptyLessons) =>
					h.div(
						[],
						[
							h.ul(
								[h.Class("space-y-3")],
								Array.map(nonEmptyLessons, (lesson) => lessonCardView(model, library, lesson, h)),
							),
							Option.isSome(maybeNextCursor)
								? h.div(
										[h.Class("mt-4 flex justify-center")],
										[
											h.button(
												[
													h.Type("button"),
													h.Class(buttonClass.secondary),
													h.Disabled(isLoadingMore),
													h.OnClick(Message.ClickedLoadMore()),
												],
												isLoadingMore ? [spinner(h), "불러오는 중…"] : ["이전 수업 더 보기"],
											),
										],
									)
								: h.empty,
						],
					),
			}),
	});

const libraryView = (model: Model, library: Library, h: H): Html =>
	h.div(
		[h.Class("min-h-dvh")],
		[
			h.header(
				[
					h.Class(
						"sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90",
					),
				],
				[
					h.div(
						[h.Class("mx-auto flex max-w-xl items-center justify-between px-4 py-3")],
						[
							h.h1([h.Class("text-lg font-semibold tracking-tight")], ["수업"]),
							runButtonView(library, h),
						],
					),
				],
			),
			h.main(
				[h.Class("mx-auto max-w-xl space-y-4 px-4 py-4 pb-16")],
				[noticeView(library, h), runStatusView(library, h), lessonListView(model, library, h)],
			),
		],
	);

export const view = (model: Model, h: H): Document => ({
	title: "언어발전소",
	body: Screen.match(model.screen, {
		CheckingSession: () => h.div([h.Class("min-h-dvh")]),
		Locked: ({ lock }) => lockView(lock, h),
		Unlocked: ({ library }) => libraryView(model, library, h),
	}),
});
