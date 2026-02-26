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

const clickByText = async (page: Page, text: string, preferLast = false): Promise<boolean> =>
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
				return false;
			}

			const target = params.preferLast ? matches[matches.length - 1] : matches[0];
			target?.click();
			return true;
		},
		{ text, preferLast },
	);

const fillLoginForm = async (page: Page, credentials: HelpspeakingCredentials): Promise<boolean> =>
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
			const hint = `${input.placeholder ?? ""} ${input.name ?? ""} ${input.id ?? ""}`.toLowerCase();
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
			return false;
		}

		const assignInputValue = (input: HTMLInputElement, value: string): void => {
			input.focus();
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		};

		assignInputValue(usernameInput, params.username);
		assignInputValue(passwordInput, params.password);
		return true;
	}, credentials);

const waitForText = (page: Page, text: string, timeout = 15_000): Promise<unknown> =>
	page.waitForFunction(
		(expectedText: string) => document.body?.innerText?.includes(expectedText),
		{ timeout },
		text,
	);

const openLatestLessonRecord = (page: Page): Promise<{ lessonLabel: string } | null> =>
	page.evaluate(() => {
		const labels = document.querySelectorAll(".bold_label");
		const recordLabel = [...labels].find((el) => el.textContent?.trim().startsWith("수업기록"));
		if (!recordLabel) return null;
		const recordTable = (function findTable(el: Element) {
			const sibling = el.nextElementSibling;
			if (!sibling || sibling?.tagName === "TABLE") return sibling;
			return findTable(sibling);
		})(recordLabel);
		if (!recordTable) return null;

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

		if (candidates.length === 0) {
			return null;
		}

		candidates.sort((left, right) => left.top - right.top);
		const target = candidates[0];
		if (!target) {
			return null;
		}

		const clickableElement = clickableElements[target.index];
		if (!clickableElement) {
			return null;
		}
		clickableElement.click();

		return {
			lessonLabel: target.cardText.slice(0, 120) || "수업기록",
		};
	});

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
				await page.goto("https://helpspeaking.kr", { waitUntil: "domcontentloaded" });
				logger("helpspeaking.navigation", "Loaded helpspeaking home page");

				const loginButtonClicked = await clickByText(page, "로그인");
				if (!loginButtonClicked) {
					throw new AutomationError({
						step: "click-login-button",
						message: "Failed to locate 로그인 button on the landing page",
					});
				}

				await sleep(750);
				const formFilled = await fillLoginForm(page, credentials);
				if (!formFilled) {
					throw new AutomationError({
						step: "fill-login-form",
						message: "Failed to locate username/password login fields",
					});
				}
				logger("helpspeaking.login", "Filled login form");

				const submitted = await clickByText(page, "로그인", true);
				if (!submitted) {
					await page.keyboard.press("Enter");
				}

				await waitForText(page, "내수업", 20_000);
				logger("helpspeaking.login", "Login submitted and 내수업 became visible");

				const myClassClicked = await clickByText(page, "내수업");
				if (!myClassClicked) {
					throw new AutomationError({
						step: "click-my-class",
						message: "Failed to locate 내수업 tab",
					});
				}
				await waitForText(page, "수업기록", 20_000);
				logger("helpspeaking.navigation", "Moved to 내수업 and found 수업기록");

				const latestRecord = await openLatestLessonRecord(page);
				if (!latestRecord) {
					throw new AutomationError({
						step: "open-latest-record",
						message: "Failed to locate 확인하기 for latest 수업기록",
					});
				}
				logger("helpspeaking.record", "Opened latest 수업기록", latestRecord);

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

				const date = latestRecord.lessonLabel.match(/\d\d\d\d\.\d\d?\.\d\d?/)?.[0] ?? "unknown";

				return {
					lessonLabel: latestRecord.lessonLabel,
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
