import inquirer from "inquirer";

import { loadOrCreateConfig, saveConfig } from "./config.ts";
import { syncMediaUnits } from "./library-sync.ts";
import { generateSampleMedia } from "./sample-data.ts";
import { defaultWeights, scoreMediaItems } from "./scoring.ts";
import type { AppConfig, ScoredMediaUnit, WeightConfig } from "./types.ts";

async function main(): Promise<void> {
	console.log("🧹 Vacuum — Plex library space recovery helper");

	const cliArgs = process.argv.slice(2);
	const requestedAction = getCliAction(cliArgs);

	if (requestedAction === "help") {
		printCliUsage();
		return;
	}

	let config = await loadOrCreateConfig();

	if (requestedAction && requestedAction !== "interactive") {
		await runAction(requestedAction, config);
		return;
	}

	let exit = false;

	while (!exit) {
		const { action } = await inquirer.prompt([
			{
				type: "list",
				name: "action",
				message: "What would you like to do?",
				choices: [
					{ name: "Sync libraries via Tautulli and rank", value: "sync" },
					{ name: "Preview ranking with sample data", value: "preview" },
					{ name: "Adjust scoring weights", value: "weights" },
					{ name: "Edit configuration", value: "config" },
					{ name: "Quit", value: "quit" },
				],
			},
		]);

		switch (action) {
			case "preview":
				await previewRanking(config);
				break;
			case "sync":
				await syncAndRank(config);
				break;
			case "weights":
				config = await adjustWeights(config);
				break;
			case "config":
				config = await reconfigure(config);
				break;
			case "quit":
				exit = true;
				break;
			default:
				exit = true;
				break;
		}
	}

	console.log("Goodbye!");
}

type MenuAction =
	| "sync"
	| "preview"
	| "weights"
	| "config"
	| "quit"
	| "interactive"
	| "help";

function getCliAction(args: string[]): MenuAction {
	const [firstArg] = args;
	switch (firstArg) {
		case "sync":
			return "sync";
		case "preview":
			return "preview";
		case "weights":
			return "weights";
		case "config":
			return "config";
		case "help":
		case "-h":
		case "--help":
			return "help";
		case undefined:
		default:
			return "interactive";
	}
}

async function runAction(action: MenuAction, config: AppConfig): Promise<void> {
	switch (action) {
		case "preview":
			await previewRanking(config);
			break;
		case "sync":
			await syncAndRank(config);
			break;
		case "weights":
			await adjustWeights(config);
			break;
		case "config":
			await reconfigure(config);
			break;
		case "quit":
		default:
			break;
	}
}

function printCliUsage(): void {
	console.log(`Usage: node src/index.ts [command]

Commands:
  sync        Run "Sync libraries via Tautulli" once and exit.
  preview     Run the sample data preview and exit.
  weights     Enter the weight adjustment workflow.
  config      Enter configuration editing.
  help        Show this help text.

With no command, the interactive menu launches as before.`);
}

async function previewRanking(config: AppConfig): Promise<void> {
	const sampleItems = generateSampleMedia();
	const scored = scoreMediaItems(sampleItems, {
		weights: config.weights,
	});

	printScoredTable(scored.slice(0, 10));
	console.log(
		"\nTip: connect to Tautulli and your library paths to rank real items.",
	);
}

function printScoredTable(items: ScoredMediaUnit[]): void {
	if (!items.length) {
		console.log("No items to display yet.");
		return;
	}

	const rows = items.map((item, index) => ({
		"#": index + 1,
		Kind: item.kind === "movie" ? "🎬" : "📺",
		Title: item.title,
		Section: item.librarySectionName,
		"Size (GB)": formatNumber(item.sizeBytes / 1024 ** 3, 2),
		"Age (years)": formatNumber(item.metrics.ageYears, 1),
		Plays: item.totalPlayCount,
		"Plays / year": formatNumber(item.metrics.playsPerYear, 2),
		"Plays / GB": formatNumber(item.metrics.playsPerGb, 3),
		"Coverage %": formatNumber(item.metrics.coverageRatio * 100, 1),
		Score: formatNumber(item.score, 3),
	}));

	console.table(rows);
}

async function syncAndRank(config: AppConfig): Promise<void> {
	if (!config.tautulli) {
		console.log(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
		);
		return;
	}

	console.log("\nSyncing libraries via Tautulli...");
	try {
		const result = await syncMediaUnits(config, { verbose: true });
		if (result.units.length === 0) {
			console.log("No media items were discovered.");
			return;
		}

		const scored = scoreMediaItems(result.units, {
			weights: config.weights,
		});

		printScoredTable(scored.slice(0, 25));
		console.log(
			`\nRanked ${result.units.length} units. Skipped ${result.skippedDueToPath} outside configured paths, ${result.skippedMissingFile} missing files.`,
		);
	} catch (error) {
		console.error("Failed to sync libraries:", error);
	}
}

async function adjustWeights(current: AppConfig): Promise<AppConfig> {
	console.log("\nCurrent weights:", current.weights);
	const updatedWeights = await promptForWeights(current.weights);
	const normalized = normalizeWeights(updatedWeights);

	const updatedConfig: AppConfig = {
		...current,
		weights: normalized,
	};

	await saveConfig(updatedConfig);
	console.log("Updated weights saved.");
	return updatedConfig;
}

async function reconfigure(current: AppConfig): Promise<AppConfig> {
	console.log(
		"\nReconfiguring setup. Leave fields blank to keep existing values.",
	);

	const answers = await inquirer.prompt([
		{
			type: "input",
			name: "tautulliUrl",
			message: "Tautulli base URL",
			default: current.tautulli?.baseUrl ?? "",
			filter: (value: string) => value.trim(),
		},
		{
			type: "password",
			name: "tautulliApiKey",
			message: "Tautulli API key",
			default: current.tautulli?.apiKey ?? "",
			mask: "*",
			filter: (value: string) => value.trim(),
		},
		{
			type: "input",
			name: "libraryPaths",
			message: "Library paths (comma separated)",
			default: current.libraryPaths.join(", "),
			filter: (value: string) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
		},
	]);

	const updatedConfig: AppConfig = {
		...current,
		tautulli:
			answers.tautulliUrl && answers.tautulliApiKey
				? {
						baseUrl: answers.tautulliUrl,
						apiKey: answers.tautulliApiKey,
					}
				: null,
		libraryPaths: [...answers.libraryPaths],
	};

	await saveConfig(updatedConfig);
	console.log("Configuration updated.");
	return updatedConfig;
}

async function promptForWeights(current: WeightConfig): Promise<WeightConfig> {
	const answers = await inquirer.prompt([
		{
			type: "number",
			name: "sizeWeight",
			message: "Weight for file size",
			default: current.sizeWeight,
			validate: validateNonNegative,
		},
		{
			type: "number",
			name: "ageWeight",
			message: "Weight for age",
			default: current.ageWeight,
			validate: validateNonNegative,
		},
		{
			type: "number",
			name: "watchWeight",
			message: "Weight for watch scarcity",
			default: current.watchWeight,
			validate: validateNonNegative,
		},
	]);

	return {
		sizeWeight: Number(answers.sizeWeight ?? defaultWeights.sizeWeight),
		ageWeight: Number(answers.ageWeight ?? defaultWeights.ageWeight),
		watchWeight: Number(answers.watchWeight ?? defaultWeights.watchWeight),
	};
}

function normalizeWeights(weights: WeightConfig): WeightConfig {
	const total =
		weights.sizeWeight + weights.ageWeight + weights.watchWeight || 1;
	return {
		sizeWeight: weights.sizeWeight / total,
		ageWeight: weights.ageWeight / total,
		watchWeight: weights.watchWeight / total,
	};
}

function validateNonNegative(value: unknown): true | string {
	const num = Number(value);
	return Number.isFinite(num) && num >= 0
		? true
		: "Enter a non-negative number";
}

function formatNumber(value: number, digits: number): string {
	return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

await main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
