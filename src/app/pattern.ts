import { Array, Option, pipe } from "effect";
import type { Point } from "./model";

export const GRID_SIZE = 3;
export const MIN_PATTERN_LENGTH = 4;
const HIT_RADIUS = 0.13;

export const dotCenter = (dot: number): Point => ({
	x: ((dot % GRID_SIZE) * 2 + 1) / (GRID_SIZE * 2),
	y: (Math.floor(dot / GRID_SIZE) * 2 + 1) / (GRID_SIZE * 2),
});

export const allDots: ReadonlyArray<number> = Array.makeBy(GRID_SIZE * GRID_SIZE, (dot) => dot);

const hitDot = (point: Point): Option.Option<number> =>
	Array.findFirst(allDots, (dot) => {
		const center = dotCenter(dot);
		return Math.hypot(center.x - point.x, center.y - point.y) <= HIT_RADIUS;
	});

const skippedDot = (from: number, to: number): Option.Option<number> => {
	const [fromRow, fromColumn] = [Math.floor(from / GRID_SIZE), from % GRID_SIZE];
	const [toRow, toColumn] = [Math.floor(to / GRID_SIZE), to % GRID_SIZE];
	const isEvenSpan = (fromRow + toRow) % 2 === 0 && (fromColumn + toColumn) % 2 === 0;
	return isEvenSpan
		? Option.some(((fromRow + toRow) / 2) * GRID_SIZE + (fromColumn + toColumn) / 2)
		: Option.none();
};

export const extendPattern = (dots: ReadonlyArray<number>, point: Point): ReadonlyArray<number> =>
	pipe(
		hitDot(point),
		Option.filter((dot) => !dots.includes(dot)),
		Option.match({
			onNone: () => dots,
			onSome: (dot) =>
				pipe(
					Array.last(dots),
					Option.flatMap((last) => skippedDot(last, dot)),
					Option.filter((middle) => !dots.includes(middle)),
					Option.match({
						onNone: () => [...dots, dot],
						onSome: (middle) => [...dots, middle, dot],
					}),
				),
		}),
	);

export const encodePattern = (dots: ReadonlyArray<number>): string =>
	dots.map((dot) => dot + 1).join("");
