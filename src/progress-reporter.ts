import process from "node:process";

export interface ProgressReporterOptions {
	label: string;
	stream?: NodeJS.WriteStream;
}

export class ProgressReporter {
	private readonly stream: NodeJS.WriteStream;
	private readonly useCarriageReturn: boolean;
	private readonly label: string;
	private totalStarted = 0;
	private completed = 0;
	private expectedTotal: number | undefined;
	private lastText = "";

	constructor(options: ProgressReporterOptions) {
		this.stream = options.stream ?? process.stderr;
		this.useCarriageReturn = Boolean(this.stream.isTTY);
		this.label = options.label;
	}

	setExpectedTotal(total?: number | null): void {
		if (typeof total === "number" && Number.isFinite(total)) {
			this.expectedTotal = total;
		} else {
			this.expectedTotal = undefined;
		}
	}

	start(text: string): void {
		this.totalStarted += 1;
		this.lastText = text;
		const currentIndex = this.completed + 1;
		this.render(currentIndex, text, false);
	}

	finish(text?: string): void {
		if (text) {
			this.lastText = text;
		}
		this.completed += 1;
		this.render(this.completed, this.lastText, true);
	}

	end(): void {
		if (this.completed === 0 && this.totalStarted === 0) {
			return;
		}
		if (this.useCarriageReturn) {
			this.clearLine();
		} else {
			this.stream.write(
				`${this.label}: done (${this.completed}/${this.displayTotal()})\n`,
			);
		}
		this.totalStarted = 0;
		this.completed = 0;
		this.expectedTotal = undefined;
		this.lastText = "";
	}

	private displayTotal(): number {
		if (this.expectedTotal !== undefined) {
			return this.expectedTotal;
		}
		return Math.max(this.totalStarted, this.completed || 1);
	}

	private render(current: number, text: string, finished: boolean): void {
		const total = this.displayTotal();
		const line = `${this.label}: (${current}/${total}) ${text}`;
		if (this.useCarriageReturn) {
			const width = this.stream.columns ?? Math.max(80, line.length + 1);
			const padded = line.padEnd(width, " ");
			this.stream.write(`\r${padded}`);
			if (finished && current === total) {
				this.clearLine();
			}
		} else {
			this.stream.write(`${line}\n`);
		}
	}

	private clearLine(): void {
		const width = this.stream.columns ?? 80;
		this.stream.write(`\r${" ".repeat(width)}\r`);
	}
}
