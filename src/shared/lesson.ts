const LESSON_ID_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export interface LessonIdParts {
	readonly date: string;
	readonly time: string | undefined;
}

export const makeLessonId = ({ date, time }: LessonIdParts): string =>
	time === undefined ? date : `${date}T${time}`;

export const parseLessonId = (id: string): LessonIdParts | undefined => {
	const match = LESSON_ID_PATTERN.exec(id);
	if (!match) {
		return undefined;
	}
	const [, year, month, day, hour, minute] = match;
	return {
		date: `${year}-${month}-${day}`,
		time: hour === undefined ? undefined : `${hour}:${minute}`,
	};
};

export const lessonWeekday = (id: string): string => {
	const parts = parseLessonId(id);
	if (!parts) {
		return "";
	}
	const [year, month, day] = parts.date.split("-").map(Number);
	return WEEKDAYS[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]!;
};

export const lessonLabel = (id: string): string => {
	const parts = parseLessonId(id);
	if (!parts) {
		return id;
	}
	const date = `${parts.date} (${lessonWeekday(id)})`;
	return parts.time ? `${date} ${parts.time}` : date;
};

export const lessonObjectFileName = (id: string): string =>
	`${id.replace("T", "-").replace(":", "")}.mp4`;

export const lessonDownloadFileName = (id: string, tutor: string | null): string => {
	const parts = parseLessonId(id);
	const base = parts?.time ? `${parts.date} ${parts.time.replace(":", "-")}` : id;
	return `${tutor ? `${base} ${tutor}` : base}.mp4`;
};
