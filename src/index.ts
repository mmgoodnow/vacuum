import inquirer from "inquirer";

import { loadOrCreateConfig, saveConfig } from "./config.ts";
import { EpisodeCache } from "./episode-cache.ts";
import { syncMediaUnits } from "./library-sync.ts";
import { generateSampleMedia } from "./sample-data.ts";
import { defaultWeights, scoreMediaItems } from "./scoring.ts";
import { TautulliClient } from "./tautulli-client.ts";
import type { AppConfig, ScoredMediaUnit, WeightConfig } from "./types.ts";

interface RunOptions {
	verbose: boolean;
	output: "table" | "tsv";
	perLibrary: boolean;
}

const DEFAULT_RUN_OPTIONS: RunOptions = {
	verbose: false,
	output: "table",
	perLibrary: false,
};

async function main(): Promise<void> {
	const cliArgs = process.argv.slice(2);
	const { action: requestedAction, flags } = parseCliArgs(cliArgs);
	const runOptions: RunOptions = {
		...DEFAULT_RUN_OPTIONS,
		verbose: hasFlag(flags, "--verbose", "-v"),
		output: hasFlag(flags, "--tsv") ? "tsv" : "table",
		perLibrary: hasFlag(flags, "--per-library"),
	};

	logInfo("🧹 Vacuum — Plex library space recovery helper", runOptions);

	if (requestedAction === "help" || hasFlag(flags, "--help", "-h")) {
		printCliUsage();
		return;
	}

	let config = await loadOrCreateConfig();

	if (requestedAction && requestedAction !== "interactive") {
		await runAction(requestedAction, config, runOptions);
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
					{
						name: "Drop stale Tautulli entries (refresh media cache)",
						value: "prune",
					},
					{ name: "Quit", value: "quit" },
				],
			},
		]);

		if (action === "quit") {
			exit = true;
			continue;
		}

		config = await runAction(action, config, runOptions);
	}

	console.log("Goodbye!");
}

type MenuAction =
	| "sync"
	| "preview"
	| "weights"
	| "config"
	| "prune"
	| "quit"
	| "interactive"
	| "help";

function parseCliArgs(
	args: string[],
): { action: MenuAction; flags: Set<string> } {
	let command: string | undefined;
	const flags = new Set<string>();

	for (const arg of args) {
		if (!command && arg && !arg.startsWith("-")) {
			command = arg;
		} else if (arg) {
			flags.add(arg);
		}
	}

	const action = getCliAction(command);
	return { action, flags };
}

function hasFlag(flags: Set<string>, ...aliases: string[]): boolean {
	return aliases.some((alias) => flags.has(alias));
}

function getCliAction(command?: string): MenuAction {
	switch (command) {
		case "sync":
			return "sync";
		case "preview":
			return "preview";
		case "weights":
			return "weights";
		case "config":
			return "config";
		case "prune":
			return "prune";
		case "help":
			return "help";
		case undefined:
		default:
			return "interactive";
	}
}

async function runAction(
	action: MenuAction,
	config: AppConfig,
	options: RunOptions,
): Promise<AppConfig> {
	switch (action) {
		case "preview":
			await previewRanking(config);
			return config;
		case "sync":
			await syncAndRank(config, options);
			return config;
		case "weights":
			return adjustWeights(config);
		case "config":
			return reconfigure(config);
		case "prune":
			await dropStaleEntries(config, options);
			return config;
		case "quit":
		default:
			return config;
	}
}

function logInfo(message: string, options: RunOptions): void {
	if (options.output === "tsv") {
		console.error(message);
	} else {
		console.log(message);
	}
}

function printCliUsage(): void {
	console.log(`Usage: node src/index.ts [command] [options]

Commands:
  sync        Run "Sync libraries via Tautulli" once and exit.
  preview     Run the sample data preview and exit.
  weights     Enter the weight adjustment workflow.
  config      Enter configuration editing.
  prune       Drop stale Tautulli entries by refreshing media cache.
  help        Show this help text.

Options:
  -v, --verbose   Enable detailed logging for supported commands.
      --tsv       Output full rankings as tab-separated values.
      --per-library  Group output by library (tables show top 25 each; TSV adds library_rank).

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

function printScoredTsv(items: ScoredMediaUnit[], options: RunOptions): void {
	const headers = [
		"rank",
		...(options.perLibrary ? ["library_rank"] : []),
		"kind",
		"title",
		"section",
		"size_gb",
		"age_years",
		"plays",
		"plays_per_year",
		"plays_per_gb",
		"coverage_pct",
		"score",
	];
	console.log(headers.join("\t"));

	const libraryRanks = new Map<string, number>();

	items.forEach((item, index) => {
		const libraryKey = `${item.librarySectionId}`;
		const currentRank = (libraryRanks.get(libraryKey) ?? 0) + 1;
		libraryRanks.set(libraryKey, currentRank);

		const row = [
			String(index + 1),
			...(options.perLibrary ? [String(currentRank)] : []),
			item.kind,
			item.title,
			item.librarySectionName,
			formatNumber(item.sizeBytes / 1024 ** 3, 2),
			formatNumber(item.metrics.ageYears, 1),
			String(item.totalPlayCount),
			formatNumber(item.metrics.playsPerYear, 2),
			formatNumber(item.metrics.playsPerGb, 3),
			formatNumber(item.metrics.coverageRatio * 100, 1),
			formatNumber(item.score, 3),
		];
		console.log(row.join("\t"));
	});
}

async function syncAndRank(
	config: AppConfig,
	options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<void> {
	if (!config.tautulli) {
		logInfo(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
			options,
		);
		return;
	}

	logInfo("\nSyncing libraries via Tautulli...", options);
	try {
		const result = await syncMediaUnits(config, { verbose: options.verbose });
		if (result.units.length === 0) {
			console.log("No media items were discovered.");
			return;
		}

		const scored = scoreMediaItems(result.units, {
			weights: config.weights,
		});

		if (options.output === "tsv") {
			printScoredTsv(scored, options);
		} else if (options.perLibrary) {
			printPerLibraryTables(scored, options);
		} else {
			printScoredTable(scored.slice(0, 25));
		}
		logInfo(
			`\nRanked ${result.units.length} units. Skipped ${result.skippedDueToPath} outside configured paths, ${result.skippedMissingFile} missing files.`,
			options,
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

async function dropStaleEntries(
	config: AppConfig,
	options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<void> {
	if (!config.tautulli) {
		logInfo(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
			options,
		);
		return;
	}

	logInfo(
		"\nDropping stale entries by clearing Tautulli media cache and refreshing libraries...",
		options,
	);
	const verbose = options.verbose;
	const episodeCache = new EpisodeCache(config.cachePath);
	episodeCache.clear();
	const client = new TautulliClient(
		config.tautulli,
		verbose ? (message) => console.error(message) : undefined,
	);
	const libraries = await client.getLibraries();
	if (!libraries.length) {
		logInfo("No libraries were returned by Tautulli.", options);
		return;
	}

	let refreshed = 0;
	for (const library of libraries) {
		try {
			if (verbose) {
				console.error(
					`- Clearing cache for ${library.section_name} (${library.section_id})`,
				);
			}
			const message = await client.deleteMediaInfoCache(library.section_id);
			if (message && verbose) {
				console.error(`  ${message}`);
			}
			await client.getLibraryMediaItems(library.section_id, {
				refresh: true,
				sectionType: library.section_type,
			});
			if (verbose) {
				console.error("  Refreshed from Plex.");
			}
			refreshed += 1;
		} catch (error) {
			console.error(
				`  Failed to refresh ${library.section_name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	logInfo(
		`\nCompleted refresh for ${refreshed} ${
			refreshed === 1 ? "library" : "libraries"
		}. Run 'node src/index.ts sync --verbose' to verify the stale entries are gone.`,
		options,
	);
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

function printPerLibraryTables(
	items: ScoredMediaUnit[],
	options: RunOptions,
): void {
	const grouped = groupByLibrary(items);
	for (const [sectionId, sectionItems] of grouped) {
		const sample = sectionItems[0];
		const sectionName = sample?.librarySectionName ?? sectionId;
		logInfo(`\nSection: ${sectionName}`, options);
		printScoredTable(sectionItems.slice(0, 25));
	}
}

function groupByLibrary(
	items: ScoredMediaUnit[],
): Map<string, ScoredMediaUnit[]> {
	const map = new Map<string, ScoredMediaUnit[]>();
	for (const item of items) {
		const key = `${item.librarySectionId}`;
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	for (const bucket of map.values()) {
		bucket.sort((a, b) => b.score - a.score);
	}
	return map;
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

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
