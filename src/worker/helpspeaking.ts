import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { env } from "cloudflare:workers";
import { Data, Effect } from "effect";
import { makeLessonId } from "../shared/lesson";

export class AutomationError extends Data.TaggedError("AutomationError")<{
	readonly step: string;
	readonly message: string;
	readonly screenshot?: string;
}> {}

export interface LessonVideoSource {
	readonly url: string;
	readonly headers: Record<string, string>;
}

export interface ScrapedLesson {
	readonly id: string;
	readonly tutor: string;
	readonly video: LessonVideoSource | null;
}

const LESSON_LABEL_PATTERN =
	/^(\d{4})\.(\d{1,2})\.(\d{1,2}) \(.\) (\d{1,2}):(\d{2}) (.+?) (?:확인하기|확인완료)$/;

const parseLessonLabel = (label: string): Omit<ScrapedLesson, "video"> | undefined => {
	const match = LESSON_LABEL_PATTERN.exec(label);
	if (!match) {
		return undefined;
	}
	const [, year, month, day, hour, minute, tutor] = match;
	const pad = (value: string | undefined) => value!.padStart(2, "0");
	return {
		id: makeLessonId({
			date: `${year}-${pad(month)}-${pad(day)}`,
			time: `${pad(hour)}:${minute}`,
		}),
		tutor: tutor!,
	};
};

const screenshot = (page: Page) =>
	page
		.screenshot({ type: "png", encoding: "base64" })
		.then((base64) => `data:image/png;base64,${base64}`)
		.catch(() => undefined);

const fail = async (page: Page, step: string, message: string): Promise<never> => {
	throw new AutomationError({ step, message, screenshot: await screenshot(page) });
};

const clickByText = (page: Page, text: string, preferLast = false) =>
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
			const target = params.preferLast ? matches[matches.length - 1] : matches[0];
			target?.click();
			return target !== undefined;
		},
		{ text, preferLast },
	);

const fillLoginForm = (page: Page, credentials: { username: string; password: string }) =>
	page.evaluate((params) => {
		const visibleInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(
			(input) => {
				const style = window.getComputedStyle(input);
				return (
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					!input.disabled &&
					input.type.toLowerCase() !== "hidden"
				);
			},
		);
		const passwordInput = visibleInputs.find((input) => input.type.toLowerCase() === "password");
		const usernameInput = visibleInputs.find((input) => {
			if (input === passwordInput) {
				return false;
			}
			const type = input.type.toLowerCase();
			const hint = `${input.placeholder ?? ""} ${input.name ?? ""} ${input.id ?? ""}`.toLowerCase();
			return (
				["text", "email", "tel", "number"].includes(type) ||
				["아이디", "id", "이메일", "email"].some((keyword) => hint.includes(keyword))
			);
		});
		if (!usernameInput || !passwordInput) {
			return false;
		}
		const assignInputValue = (input: HTMLInputElement, value: string) => {
			input.focus();
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		};
		assignInputValue(usernameInput, params.username);
		assignInputValue(passwordInput, params.password);
		return true;
	}, credentials);

const MAX_RECORDS = 10;
const VIDEO_WAIT_MS = 8_000;

const waitForText = (page: Page, text: string) =>
	page
		.waitForFunction(
			(expectedText: string) => document.body?.innerText?.includes(expectedText),
			{ timeout: 20_000 },
			text,
		)
		.then(() => true)
		.catch(() => false);

const findRecordTable = (page: Page) =>
	page.evaluateHandle(() => {
		const recordLabel = [...document.querySelectorAll(".bold_label")].find((el) =>
			el.textContent?.trim().startsWith("수업기록"),
		);
		let recordTable = recordLabel?.nextElementSibling ?? null;
		while (recordTable && recordTable.tagName !== "TABLE") {
			recordTable = recordTable.nextElementSibling;
		}
		return {
			buttons: recordTable
				? Array.from(
						recordTable.querySelectorAll<HTMLElement>(
							"button, a, [role='button'], input[type='button'], input[type='submit']",
						),
					)
				: null,
		};
	});

const listRecords = async (page: Page) => {
	const table = await findRecordTable(page);
	const records = await table.evaluate(({ buttons }) =>
		buttons
			?.flatMap((element, index) => {
				const label =
					element instanceof HTMLInputElement ? element.value : (element.textContent ?? "");
				const normalizedLabel = label.replaceAll(/\s+/g, " ").trim();
				if (!normalizedLabel.includes("확인하기") && !normalizedLabel.includes("확인완료")) {
					return [];
				}
				return [
					{
						index,
						top: element.getBoundingClientRect().top,
						label: (element.closest("tr")?.textContent ?? "").replaceAll(/\s+/g, " ").trim(),
					},
				];
			})
			.sort((left, right) => left.top - right.top),
	);
	await table.dispose();
	return records?.slice(0, MAX_RECORDS);
};

const openRecord = async (page: Page, index: number) => {
	const table = await findRecordTable(page);
	const isOpened = await table.evaluate(({ buttons }, buttonIndex) => {
		const target = buttons?.[buttonIndex];
		target?.click();
		return target !== undefined;
	}, index);
	await table.dispose();
	return isOpened;
};

export const scrapeRecentLessons = Effect.tryPromise({
	try: async () => {
		const browser = await puppeteer.launch(env.BROWSER);
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 800, height: 800 });
			const userAgent = await browser.userAgent();
			await page.goto("https://helpspeaking.kr", { waitUntil: "domcontentloaded" });

			if (!(await clickByText(page, "로그인"))) {
				await fail(page, "click-login-button", '"로그인" 버튼을 찾을 수 없어요');
			}
			if (!(await waitForText(page, "아이디"))) {
				await fail(page, "wait-for-id", '"아이디" 로그인 양식이 나타나지 않았어요');
			}
			const filled = await fillLoginForm(page, {
				username: env.HELPSPEAKING_USERNAME,
				password: env.HELPSPEAKING_PASSWORD,
			});
			if (!filled) {
				await fail(page, "fill-login-form", "아이디/비밀번호 입력란을 찾을 수 없어요");
			}
			if (!(await clickByText(page, "로그인", true))) {
				await page.keyboard.press("Enter");
			}
			if (!(await waitForText(page, "내수업"))) {
				await fail(page, "wait-for-my-class", '로그인 후 "내수업"이 나타나지 않았어요');
			}
			if (!(await clickByText(page, "내수업"))) {
				await fail(page, "click-my-class", '"내수업" 탭을 찾을 수 없어요');
			}
			if (!(await waitForText(page, "수업기록"))) {
				await fail(page, "wait-for-record", '"수업기록"이 나타나지 않았어요');
			}

			const records = await listRecords(page);
			if (!records) {
				return await fail(page, "list-records", "수업기록 표를 찾을 수 없어요");
			}

			const lessons: ScrapedLesson[] = [];
			for (const record of records) {
				const parsed = parseLessonLabel(record.label);
				if (!parsed) {
					return await fail(page, "parse-record", `알 수 없는 수업 행: "${record.label}"`);
				}

				if (!(await openRecord(page, record.index))) {
					return await fail(page, "open-record", "수업기록 표를 찾을 수 없어요");
				}
				try {
					const source = await page
						.waitForSelector("video source", { timeout: VIDEO_WAIT_MS })
						.then(() =>
							page.evaluate(() => ({
								src: document.querySelector("video source")?.getAttribute("src") ?? null,
								pageUrl: window.location.href,
							})),
						)
						.catch(() => null);

					if (!source?.src) {
						lessons.push({ ...parsed, video: null });
						continue;
					}
					const url = new URL(source.src, source.pageUrl).toString();
					const cookies = await page.cookies(url);
					lessons.push({
						...parsed,
						video: {
							url,
							headers: {
								Referer: source.pageUrl,
								"User-Agent": userAgent,
								...(cookies.length > 0 && {
									Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
								}),
							},
						},
					});
				} finally {
					await page.goBack();
				}
			}
			return lessons;
		} finally {
			await browser.close();
		}
	},
	catch: (error) =>
		error instanceof AutomationError
			? error
			: new AutomationError({ step: "scrape", message: String(error) }),
});
