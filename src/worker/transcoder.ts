import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { LessonPhase } from "../shared/api";

export interface TranscodeJob {
	readonly runId: string;
	readonly jobId: string;
	readonly sourceUrl: string;
	readonly sourceHeaders: Record<string, string>;
	readonly objectKey: string;
}

export type TranscodeState =
	| { readonly phase: "idle" }
	| { readonly phase: LessonPhase; readonly progress: number | null }
	| { readonly phase: "done"; readonly size: number; readonly duration: number }
	| { readonly phase: "failed"; readonly error: string };

const STATE_FILE = "/work/state";
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const isActivePhase = Schema.is(LessonPhase);

type StateFields = Partial<
	Record<"job" | "phase" | "progress" | "size" | "duration" | "error", string>
>;

const parseFields = (raw: string): StateFields =>
	Object.fromEntries(
		raw.split("\n").flatMap((line) => {
			const separator = line.indexOf("=");
			return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
		}),
	);

const toState = (fields: StateFields, jobId: string): TranscodeState => {
	if (fields.job !== jobId) {
		return { phase: "idle" };
	}
	if (fields.phase === "done") {
		return { phase: "done", size: Number(fields.size), duration: Number(fields.duration) };
	}
	if (fields.phase === "failed") {
		return { phase: "failed", error: fields.error || "변환에 실패했어요" };
	}
	if (isActivePhase(fields.phase)) {
		const progress = Number.parseFloat(fields.progress ?? "");
		return { phase: fields.phase, progress: Number.isFinite(progress) ? progress : null };
	}
	return { phase: "idle" };
};

const isOwnedByOtherRun = (fields: StateFields, runId: string) =>
	isActivePhase(fields.phase) && !fields.job?.startsWith(`${runId}#`);

export class Transcoder extends DurableObject<Env> {
	private get container() {
		const container = this.ctx.container;
		if (!container) {
			throw new Error("Transcoder has no container attached");
		}
		return container;
	}

	/** Returns false when another run's job is still active in this container. */
	async start(job: TranscodeJob): Promise<boolean> {
		if (!this.container.running) {
			// NOTE: under the default scheduling policy the image and instance type come from the
			// wrangler config, so the runtime accepts start options without an `image`.
			this.container.start({ enableInternet: true } as ContainerStartupOptions);
		}
		await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		const fields = await this.readFields();
		if (fields.job === job.jobId) {
			return true;
		}
		if (isOwnedByOtherRun(fields, job.runId)) {
			return false;
		}
		await this.ctx.storage.put("jobId", job.jobId);
		await this.container.exec(["/usr/local/bin/transcode.sh", "job"], {
			env: {
				JOB_ID: job.jobId,
				SOURCE_URL: job.sourceUrl,
				SOURCE_HEADERS: Object.entries(job.sourceHeaders)
					.map(([name, value]) => `${name}: ${value}`)
					.join("\n"),
				OBJECT_KEY: job.objectKey,
				R2_ENDPOINT: this.env.R2_ENDPOINT,
				R2_BUCKET: this.env.R2_BUCKET,
				R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
				R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		return true;
	}

	async status(jobId: string): Promise<TranscodeState> {
		if (!this.container.running) {
			return (await this.ctx.storage.get("jobId")) === jobId
				? { phase: "failed", error: "변환 컨테이너가 예기치 않게 종료됐어요" }
				: { phase: "idle" };
		}
		return toState(await this.readFields(), jobId);
	}

	async stop(runId: string): Promise<void> {
		if (this.container.running) {
			if (isOwnedByOtherRun(await this.readFields(), runId)) {
				return;
			}
			await this.container.destroy();
		}
		await this.ctx.storage.delete("jobId");
	}

	private async readFields(): Promise<StateFields> {
		const process = await this.container.exec(["cat", STATE_FILE], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const { stdout, exitCode } = await process.output();
		return exitCode === 0 ? parseFields(new TextDecoder().decode(stdout)) : {};
	}
}
