import { Array, Match, Option } from "effect";
import type { Runtime, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Lesson, LessonPage, Run } from "../shared/api";
import {
	CheckSession,
	DeleteLesson,
	LoadFirstPage,
	LoadMoreLessons,
	LoadStatus,
	RetryLesson,
	StartRun,
	Unlock,
	WaitBeforeResetPattern,
} from "./command";
import { type ApiFailure, Message, type UnlockFailure } from "./message";
import {
	type Flags,
	type Library,
	type Lock,
	LessonList,
	LockStatus,
	type Model,
	RowMode,
	Screen,
} from "./model";
import { encodePattern, extendPattern, MIN_PATTERN_LENGTH } from "./pattern";

type UpdateReturn = Update.Return<Model, Message>;

const initialLock: Lock = { dots: [], maybePointer: Option.none(), status: LockStatus.Idle() };

const initialLibrary: Library = {
	lessons: LessonList.Loading(),
	maybeRun: Option.none(),
	isStartingRun: false,
	rowMode: RowMode.Closed(),
	busyLessonIds: [],
	expandedErrorIds: [],
	isScreenshotOpen: false,
	maybeNotice: Option.none(),
};

export const isRunActive = (maybeRun: Option.Option<Run>): boolean =>
	Option.exists(maybeRun, (run) => run.status === "running");

export const isLessonActive = (lesson: Lesson): boolean =>
	lesson.status === "queued" || lesson.status === "processing";

export const isPolling = (library: Library): boolean =>
	isRunActive(library.maybeRun) ||
	(library.lessons._tag === "Loaded" && Array.some(library.lessons.lessons, isLessonActive));

const unlockFailureReason = (failure: UnlockFailure): string =>
	Match.value(failure).pipe(
		Match.when("WrongPattern", () => "패턴이 틀렸어요"),
		Match.when("TooManyAttempts", () => "시도가 너무 많아요. 1분 뒤에 다시 해 보세요."),
		Match.when("Network", () => "서버에 연결할 수 없어요"),
		Match.exhaustive,
	);

const mergeFirstPage = (lessons: LessonList, page: LessonPage): LessonList =>
	LessonList.match(lessons, {
		Loaded: ({ lessons: current, maybeNextCursor, isLoadingMore }) => {
			const oldest = Array.last(page.lessons);
			const hasMoreLoaded = Option.isSome(maybeNextCursor) || current.length > page.lessons.length;
			const rest = Option.match(oldest, {
				onNone: () => [],
				onSome: ({ id }) => Array.filter(current, (lesson) => lesson.id < id),
			});
			return LessonList.Loaded({
				lessons: [...page.lessons, ...(hasMoreLoaded ? rest : [])],
				maybeNextCursor: Array.isArrayNonEmpty(rest) ? maybeNextCursor : page.nextCursor,
				isLoadingMore,
			});
		},
		Loading: () =>
			LessonList.Loaded({
				lessons: page.lessons,
				maybeNextCursor: page.nextCursor,
				isLoadingMore: false,
			}),
		LoadFailed: () =>
			LessonList.Loaded({
				lessons: page.lessons,
				maybeNextCursor: page.nextCursor,
				isLoadingMore: false,
			}),
	});

const unlocked = (model: Model): UpdateReturn => ({
	model: modifyFields(model, { screen: () => Screen.Unlocked({ library: initialLibrary }) }),
	commands: [LoadFirstPage(), LoadStatus()],
});

export const init: Runtime.ApplicationInit<Model, Message, Flags> = (flags) => ({
	model: { isAndroid: flags.isAndroid, now: flags.now, screen: Screen.CheckingSession() },
	commands: [CheckSession()],
});

const withLock = (model: Model, f: (lock: Lock) => UpdateReturn): UpdateReturn =>
	model.screen._tag === "Locked" ? f(model.screen.lock) : { model };

const setLock = (model: Model, lock: Lock): Model =>
	modifyFields(model, { screen: () => Screen.Locked({ lock }) });

const withLibrary = (model: Model, f: (library: Library) => UpdateReturn): UpdateReturn =>
	model.screen._tag === "Unlocked" ? f(model.screen.library) : { model };

const setLibrary = (model: Model, library: Library): Model =>
	modifyFields(model, { screen: () => Screen.Unlocked({ library }) });

const lockScreen = (model: Model): UpdateReturn => ({ model: setLock(model, initialLock) });

const handleFailure = (
	model: Model,
	library: Library,
	failure: ApiFailure,
	patch: (library: Library) => Library = (current) => current,
): UpdateReturn =>
	failure._tag === "Unauthorized"
		? lockScreen(model)
		: {
				model: setLibrary(
					model,
					modifyFields(patch(library), { maybeNotice: () => Option.some(failure.error) }),
				),
			};

const removeId = (ids: ReadonlyArray<string>, id: string) =>
	Array.filter(ids, (other) => other !== id);

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		SucceededCheckSession: () => unlocked(model),
		FailedCheckSession: () => lockScreen(model),

		PressedPattern: (point) =>
			withLock(model, (lock) =>
				lock.status._tag === "Verifying"
					? { model }
					: {
							model: setLock(model, {
								dots: extendPattern([], point),
								maybePointer: Option.some(point),
								status: LockStatus.Drawing(),
							}),
						},
			),
		MovedPatternPointer: (point) =>
			withLock(model, (lock) =>
				lock.status._tag === "Drawing"
					? {
							model: setLock(
								model,
								modifyFields(lock, {
									dots: (dots) => extendPattern(dots, point),
									maybePointer: () => Option.some(point),
								}),
							),
						}
					: { model },
			),
		ReleasedPattern: () =>
			withLock(model, (lock) => {
				if (lock.status._tag !== "Drawing") {
					return { model };
				}
				if (lock.dots.length < MIN_PATTERN_LENGTH) {
					return {
						model: setLock(
							model,
							modifyFields(lock, {
								maybePointer: () => Option.none(),
								status: () =>
									LockStatus.Rejected({ reason: `점을 ${MIN_PATTERN_LENGTH}개 이상 연결하세요` }),
							}),
						),
						commands: [WaitBeforeResetPattern()],
					};
				}
				return {
					model: setLock(
						model,
						modifyFields(lock, {
							maybePointer: () => Option.none(),
							status: () => LockStatus.Verifying(),
						}),
					),
					commands: [Unlock({ pattern: encodePattern(lock.dots) })],
				};
			}),
		SucceededUnlock: () => unlocked(model),
		FailedUnlock: ({ failure }) =>
			withLock(model, (lock) => ({
				model: setLock(
					model,
					modifyFields(lock, {
						status: () => LockStatus.Rejected({ reason: unlockFailureReason(failure) }),
					}),
				),
				commands: [WaitBeforeResetPattern()],
			})),
		CompletedWaitBeforeResetPattern: () =>
			withLock(model, (lock) => (lock.status._tag === "Rejected" ? lockScreen(model) : { model })),

		SucceededLoadFirstPage: ({ page }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, { lessons: (lessons) => mergeFirstPage(lessons, page) }),
				),
			})),
		SucceededLoadMoreLessons: ({ page }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						lessons: (lessons) =>
							lessons._tag === "Loaded"
								? LessonList.Loaded({
										lessons: [
											...lessons.lessons,
											...Array.filter(
												page.lessons,
												(lesson) => !Array.some(lessons.lessons, ({ id }) => id === lesson.id),
											),
										],
										maybeNextCursor: page.nextCursor,
										isLoadingMore: false,
									})
								: lessons,
					}),
				),
			})),
		FailedLoadFirstPage: ({ failure }) =>
			withLibrary(model, (library) =>
				failure._tag === "Failed" && library.lessons._tag !== "Loaded"
					? {
							model: setLibrary(
								model,
								modifyFields(library, {
									lessons: () => LessonList.LoadFailed({ error: failure.error }),
								}),
							),
						}
					: handleFailure(model, library, failure),
			),
		FailedLoadMoreLessons: ({ failure }) =>
			withLibrary(model, (library) =>
				handleFailure(model, library, failure, (current) =>
					modifyFields(current, {
						lessons: (lessons) =>
							lessons._tag === "Loaded"
								? modifyFields(lessons, { isLoadingMore: () => false })
								: lessons,
					}),
				),
			),
		ClickedLoadMore: () =>
			withLibrary(model, (library) => {
				const { lessons } = library;
				if (lessons._tag !== "Loaded" || lessons.isLoadingMore) {
					return { model };
				}
				return Option.match(lessons.maybeNextCursor, {
					onNone: () => ({ model }),
					onSome: (cursor) => ({
						model: setLibrary(
							model,
							modifyFields(library, {
								lessons: () => modifyFields(lessons, { isLoadingMore: () => true }),
							}),
						),
						commands: [LoadMoreLessons({ cursor })],
					}),
				});
			}),

		TickedPoll: ({ now }) =>
			withLibrary(model, () => ({
				model: modifyFields(model, { now: () => now }),
				commands: [LoadStatus(), LoadFirstPage()],
			})),
		SucceededLoadStatus: ({ status }) =>
			withLibrary(model, (library) => {
				const nextModel = setLibrary(model, modifyFields(library, { maybeRun: () => status.run }));
				return isRunActive(library.maybeRun) && !isRunActive(status.run)
					? { model: nextModel, commands: [LoadFirstPage()] }
					: { model: nextModel };
			}),
		FailedLoadStatus: ({ failure }) =>
			withLibrary(model, () => (failure._tag === "Unauthorized" ? lockScreen(model) : { model })),

		ClickedRun: () =>
			withLibrary(model, (library) =>
				library.isStartingRun || isRunActive(library.maybeRun)
					? { model }
					: {
							model: setLibrary(model, modifyFields(library, { isStartingRun: () => true })),
							commands: [StartRun()],
						},
			),
		SucceededStartRun: ({ run }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						isStartingRun: () => false,
						maybeRun: () => Option.some(run),
					}),
				),
			})),
		FailedStartRun: ({ failure }) =>
			withLibrary(model, (library) =>
				handleFailure(model, library, failure, (current) =>
					modifyFields(current, { isStartingRun: () => false }),
				),
			),

		ClickedRetry: ({ lessonId }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, { busyLessonIds: (ids) => [...ids, lessonId] }),
				),
				commands: [RetryLesson({ lessonId })],
			})),
		SucceededRetryLesson: ({ lessonId, run }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						busyLessonIds: (ids) => removeId(ids, lessonId),
						maybeRun: () => Option.some(run),
					}),
				),
			})),
		FailedRetryLesson: ({ lessonId, failure }) =>
			withLibrary(model, (library) =>
				handleFailure(model, library, failure, (current) =>
					modifyFields(current, { busyLessonIds: (ids) => removeId(ids, lessonId) }),
				),
			),

		ClickedRowMenu: ({ lessonId }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						rowMode: (rowMode) =>
							rowMode._tag === "MenuOpen" && rowMode.lessonId === lessonId
								? RowMode.Closed()
								: RowMode.MenuOpen({ lessonId }),
					}),
				),
			})),
		ClickedDelete: ({ lessonId }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, { rowMode: () => RowMode.ConfirmingDelete({ lessonId }) }),
				),
			})),
		ClickedCancelDelete: () =>
			withLibrary(model, (library) => ({
				model: setLibrary(model, modifyFields(library, { rowMode: () => RowMode.Closed() })),
			})),
		ClickedConfirmDelete: ({ lessonId }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						rowMode: () => RowMode.Closed(),
						busyLessonIds: (ids) => [...ids, lessonId],
					}),
				),
				commands: [DeleteLesson({ lessonId })],
			})),
		SucceededDeleteLesson: ({ lessonId }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						busyLessonIds: (ids) => removeId(ids, lessonId),
						lessons: (lessons) =>
							lessons._tag === "Loaded"
								? modifyFields(lessons, {
										lessons: (current) => Array.filter(current, ({ id }) => id !== lessonId),
									})
								: lessons,
					}),
				),
			})),
		FailedDeleteLesson: ({ lessonId, failure }) =>
			withLibrary(model, (library) =>
				handleFailure(model, library, failure, (current) =>
					modifyFields(current, { busyLessonIds: (ids) => removeId(ids, lessonId) }),
				),
			),

		ToggledErrorDetails: ({ lessonId, isOpen }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(
					model,
					modifyFields(library, {
						expandedErrorIds: (ids) =>
							isOpen ? [...removeId(ids, lessonId), lessonId] : removeId(ids, lessonId),
					}),
				),
			})),
		ToggledScreenshot: ({ isOpen }) =>
			withLibrary(model, (library) => ({
				model: setLibrary(model, modifyFields(library, { isScreenshotOpen: () => isOpen })),
			})),
		ClickedDismissNotice: () =>
			withLibrary(model, (library) => ({
				model: setLibrary(model, modifyFields(library, { maybeNotice: () => Option.none() })),
			})),
	});
