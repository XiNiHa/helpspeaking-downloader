import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { Effect } from "effect";
import { AutomationError, toErrorMessage } from "./errors";
import type { DebugLogger } from "./logging";

export interface HelpspeakingCredentials {
	readonly username: string;
	readonly password: string;
}

export interface LatestLessonVideo {
	readonly lessonLabel: string;
	readonly date: string;
	readonly videoUrl: string;
	readonly referer: string;
	readonly cookieHeader: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// biome-ignore lint/suspicious/noExplicitAny: needed by typescript extends
type Action<TOut> = (page: Page, ...args: any[]) => Promise<TOut | { error: string }>;

const withScreenshotOnError =
	<TOut, TAction extends Action<TOut>>(fn: TAction) =>
	async (
		...[page, ...rest]: Parameters<TAction>
	): Promise<
		| { out: Awaited<TOut>; error?: never }
		| { out?: never; error: { message: string; screenshotUrl: string } }
	> => {
		const result = await fn(page, ...rest);
		if (
			result &&
			typeof result === "object" &&
			"error" in result &&
			typeof result.error === "string"
		) {
			return {
				error: {
					message: result.error,
					screenshotUrl: await page
						.screenshot({ type: "png" })
						.then((buf) => `data:image/png;base64,${buf.toString("base64url")}`),
				},
			};
		}
		return { out: result as Awaited<TOut> };
	};

const clickByText = withScreenshotOnError(async (page: Page, text: string, preferLast = false) =>
	page.evaluate(
		(params: { text: string; preferLast: boolean }) => {
			const candidates = Array.from(
				document.querySelectorAll<HTMLElement>(
					"button, a, [role='button'], input[type='button'], input[type='submit']",
				),
			);
			const matches = candidates.filter((candidate) => {
				const label =
					candidate instanceof HTMLInputElement ? candidate.value : (candidate.textContent ?? "");
				return label.replaceAll(/\s+/g, " ").trim().includes(params.text);
			});
			if (matches.length === 0) {
				return { error: `cannot find any button with the requested text: "${params.text}"` };
			}

			const target = params.preferLast ? matches[matches.length - 1] : matches[0];
			target?.click();
		},
		{ text, preferLast },
	),
);

const fillLoginForm = withScreenshotOnError(
	async (page: Page, credentials: HelpspeakingCredentials) =>
		page.evaluate((params: HelpspeakingCredentials) => {
			const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
			const visibleInputs = inputs.filter((input) => {
				const style = window.getComputedStyle(input);
				return (
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					!input.disabled &&
					input.type.toLowerCase() !== "hidden"
				);
			});
			const passwordInput = visibleInputs.find((input) => input.type.toLowerCase() === "password");
			const usernameInput = visibleInputs.find((input) => {
				if (input === passwordInput) {
					return false;
				}

				const type = input.type.toLowerCase();
				const hint =
					`${input.placeholder ?? ""} ${input.name ?? ""} ${input.id ?? ""}`.toLowerCase();
				return (
					type === "text" ||
					type === "email" ||
					type === "tel" ||
					type === "number" ||
					hint.includes("아이디") ||
					hint.includes("id") ||
					hint.includes("이메일") ||
					hint.includes("email")
				);
			});

			if (!usernameInput || !passwordInput) {
				return { error: "username/password input not found" };
			}

			const assignInputValue = (input: HTMLInputElement, value: string): void => {
				input.focus();
				input.value = value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			};

			assignInputValue(usernameInput, params.username);
			assignInputValue(passwordInput, params.password);
		}, credentials),
);

const waitForText = withScreenshotOnError(async (page: Page, text: string, timeout = 15_000) =>
	page
		.waitForFunction(
			(expectedText: string) => document.body?.innerText?.includes(expectedText),
			{ timeout },
			text,
		)
		.then(() => undefined)
		.catch(() => ({ error: `Failed to find text until timeout: ${text}` })),
);

const openLatestLessonRecord = withScreenshotOnError(
	(page: Page): Promise<{ lessonLabel: string } | { error: string }> =>
		page.evaluate(() => {
			const labels = document.querySelectorAll(".bold_label");
			const recordLabel = [...labels].find((el) => el.textContent?.trim().startsWith("수업기록"));
			if (!recordLabel) return { error: 'failed to find "수업기록" label' };
			const recordTable = (function findTable(el: Element) {
				const sibling = el.nextElementSibling;
				if (!sibling || sibling?.tagName === "TABLE") return sibling;
				return findTable(sibling);
			})(recordLabel);
			if (!recordTable) return { error: "failed to find the record table" };

			const clickableElements = Array.from(
				recordTable.querySelectorAll<HTMLElement>(
					"button, a, [role='button'], input[type='button'], input[type='submit']",
				),
			);
			const candidates: Array<{
				readonly index: number;
				readonly top: number;
				readonly cardText: string;
			}> = [];

			clickableElements.forEach((element, index) => {
				const label =
					element instanceof HTMLInputElement ? element.value : (element.textContent ?? "");
				const normalizedLabel = label.replaceAll(/\s+/g, " ").trim();
				if (!normalizedLabel.includes("확인하기") && !normalizedLabel.includes("확인완료")) {
					return;
				}

				const container = element.closest("tr");
				const cardText = (container?.textContent ?? "").replaceAll(/\s+/g, " ").trim();
				const top = Number.isFinite(element.getBoundingClientRect().top)
					? element.getBoundingClientRect().top
					: Number.MAX_SAFE_INTEGER;
				candidates.push({
					index,
					top,
					cardText,
				});
			});

			candidates.sort((left, right) => left.top - right.top);
			const target = candidates[0];
			const clickableElement = target && clickableElements[target.index];
			if (!clickableElement) {
				return {
					error: 'failed to find a valid clickable element with either "확인하기" or "확인완료"',
				};
			}
			clickableElement.click();

			return {
				lessonLabel: target.cardText.slice(0, 120) || "수업기록",
			};
		}),
);

export const fetchLatestLessonVideo = ({
	browserBinding,
	credentials,
	logger,
}: {
	readonly browserBinding: Fetcher;
	readonly credentials: HelpspeakingCredentials;
	readonly logger: DebugLogger;
}): Effect.Effect<LatestLessonVideo, AutomationError> =>
	Effect.tryPromise({
		try: async () => {
			const browser = await puppeteer.launch(browserBinding);
			logger("helpspeaking.browser", "Browser launched");

			try {
				const page = await browser.newPage();
				await page.setViewport({ width: 800, height: 800 });
				await page.goto("https://helpspeaking.kr", { waitUntil: "domcontentloaded" });
				logger("helpspeaking.navigation", "Loaded helpspeaking home page");

				const loginClickResult = await clickByText(page, "로그인");
				if (loginClickResult.error) {
					throw new AutomationError({
						step: "click-login-button",
						message: loginClickResult.error.message,
						screenshotUrl: loginClickResult.error.screenshotUrl,
					});
				}

				await sleep(750);
				const formFillResult = await fillLoginForm(page, credentials);
				if (formFillResult.error) {
					throw new AutomationError({
						step: "fill-login-form",
						message: formFillResult.error.message,
						screenshotUrl: formFillResult.error.screenshotUrl,
					});
				}
				logger("helpspeaking.login", "Filled login form");

				const submitResult = await clickByText(page, "로그인", true);
				if (submitResult.error) {
					await page.keyboard.press("Enter");
				}

				const waitForMyClassResult = await waitForText(page, "내수업", 20_000);
				if (waitForMyClassResult.error) {
					throw new AutomationError({
						step: "wait-for-my-class",
						message: waitForMyClassResult.error.message,
						screenshotUrl: waitForMyClassResult.error.screenshotUrl,
					});
				}
				logger("helpspeaking.login", "Login submitted and 내수업 became visible");

				const myClassClickResult = await clickByText(page, "내수업");
				if (myClassClickResult.error) {
					throw new AutomationError({
						step: "click-my-class",
						message: "Failed to locate 내수업 tab",
						screenshotUrl: myClassClickResult.error.screenshotUrl,
					});
				}
				const waitForRecordResult = await waitForText(page, "수업기록", 20_000);
				if (waitForRecordResult.error) {
					throw new AutomationError({
						step: "wait-for-record",
						message: waitForRecordResult.error.message,
						screenshotUrl: waitForRecordResult.error.screenshotUrl,
					});
				}
				logger("helpspeaking.navigation", "Moved to 내수업 and found 수업기록");

				const openLatestRecordResult = await openLatestLessonRecord(page);
				if (openLatestRecordResult.error) {
					throw new AutomationError({
						step: "open-latest-record",
						message: openLatestRecordResult.error.message,
						screenshotUrl: openLatestRecordResult.error.screenshotUrl,
					});
				}
				logger("helpspeaking.record", "Opened latest 수업기록", openLatestRecordResult);

				await page.waitForSelector("video source", { timeout: 20_000 });
				const sourceInfo = await page.evaluate(() => {
					const source = document.querySelector<HTMLSourceElement>("video source");
					if (!source) {
						return null;
					}

					return {
						src: source.getAttribute("src"),
						pageUrl: window.location.href,
					};
				});
				if (!sourceInfo?.src) {
					throw new AutomationError({
						step: "extract-video-source",
						message: "video source tag exists but src is missing",
					});
				}

				const videoUrl = new URL(sourceInfo.src, sourceInfo.pageUrl).toString();
				const cookies = await page.cookies(videoUrl);
				const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
				logger("helpspeaking.video", "Extracted video source URL", {
					videoUrl,
					cookieCount: cookies.length,
				});

				const date =
					openLatestRecordResult.out.lessonLabel.match(/\d\d\d\d\.\d\d?\.\d\d?/)?.[0] ?? "unknown";

				return {
					lessonLabel: openLatestRecordResult.out.lessonLabel,
					date,
					videoUrl,
					referer: sourceInfo.pageUrl,
					cookieHeader,
				} satisfies LatestLessonVideo;
			} finally {
				await browser.close();
				logger("helpspeaking.browser", "Browser closed");
			}
		},
		catch: (error) =>
			error instanceof AutomationError
				? error
				: new AutomationError({
						step: "fetch-latest-lesson-video",
						message: toErrorMessage(error),
						cause: error,
					}),
	});
