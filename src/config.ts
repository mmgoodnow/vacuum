import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";
import { defaultWeights } from "./scoring.ts";
import type { AppConfig, ArrConfig } from "./types.ts";

const CONFIG_DIR =
	process.env.VACUUM_CONFIG_DIR ?? path.join(os.homedir(), ".config", "vacuum");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_CACHE_PATH = path.join(CONFIG_DIR, "cache.sqlite");

export async function loadOrCreateConfig(): Promise<AppConfig> {
	const existing = await loadConfigFromDisk();
	if (existing) {
		return existing;
	}
	return promptForInitialConfig();
}

export async function saveConfig(config: AppConfig): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export async function updateConfig(
	updater: (config: AppConfig) => AppConfig | Promise<AppConfig>,
): Promise<AppConfig> {
	const current = await loadOrCreateConfig();
	const next = await updater(current);
	await saveConfig(next);
	return next;
}

async function loadConfigFromDisk(): Promise<AppConfig | null> {
	try {
		await access(CONFIG_FILE);
	} catch {
		return null;
	}

	try {
		const raw = await readFile(CONFIG_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<AppConfig>;
		return normalizeConfig(parsed);
	} catch (error) {
		console.error("Failed to read existing config, re-running setup.", error);
		return null;
	}
}

async function promptForInitialConfig(): Promise<AppConfig> {
	await mkdir(CONFIG_DIR, { recursive: true });

	const answers = await inquirer.prompt([
		{
			type: "input",
			name: "tautulliUrl",
			message: "Tautulli base URL (leave blank to skip for now)",
			filter: (value: string) => value.trim(),
		},
		{
			type: "password",
			name: "tautulliApiKey",
			message: "Tautulli API key (leave blank to skip)",
			mask: "*",
			filter: (value: string) => value.trim(),
		},
		{
			type: "input",
			name: "libraryPaths",
			message:
				"Library root paths to scan (comma separated, you can edit later)",
			filter: (value: string) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
		},
	]);

	const sonarr = await promptForArrIntegration("Sonarr");
	const radarr = await promptForArrIntegration("Radarr");

	const config = normalizeConfig({
		tautulli:
			answers.tautulliUrl && answers.tautulliApiKey
				? {
						baseUrl: answers.tautulliUrl,
						apiKey: answers.tautulliApiKey,
					}
				: null,
		sonarr,
		radarr,
		libraryPaths: answers.libraryPaths,
		blockedTitles: [],
		weights: defaultWeights,
		cachePath: DEFAULT_CACHE_PATH,
	});

	await saveConfig(config);
	return config;
}

async function promptForArrIntegration(kind: "Sonarr" | "Radarr"): Promise<ArrConfig | null> {
	const { enable } = await inquirer.prompt<{ enable: boolean }>([
		{
			type: "confirm",
			name: "enable",
			message: `Configure ${kind} integration now?`,
			default: false,
		},
	]);

	if (!enable) {
		return null;
	}

	const answers = await inquirer.prompt<{
		baseUrl: string;
		apiKey: string;
	}>([
		{
			type: "input",
			name: "baseUrl",
			message: `${kind} base URL`,
			filter: (value: string) => value.trim(),
		},
		{
			type: "password",
			name: "apiKey",
			message: `${kind} API key`,
			mask: "*",
			filter: (value: string) => value.trim(),
		},
	]);

	if (!answers.baseUrl || !answers.apiKey) {
		console.warn(`${kind} settings incomplete, skipping integration.`);
		return null;
	}

	return {
		baseUrl: answers.baseUrl,
		apiKey: answers.apiKey,
	};
}

function normalizeConfig(partial: Partial<AppConfig>): AppConfig {
	const weights = partial.weights ?? { ...defaultWeights };
	const libraryPaths = partial.libraryPaths ?? [];

	return {
		tautulli: partial.tautulli ?? null,
		sonarr: partial.sonarr ?? null,
		radarr: partial.radarr ?? null,
		libraryPaths,
		blockedTitles: partial.blockedTitles ?? [],
		weights: { ...weights },
		cachePath: partial.cachePath ?? DEFAULT_CACHE_PATH,
	};
}
