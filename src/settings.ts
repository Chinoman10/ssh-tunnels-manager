import path from "node:path";
import type { ProbePermission } from "./types.ts";
import { ensureConfigDir, readJsonFile, writeJsonFile } from "./utils.ts";

interface SettingsFile {
  probePermission: ProbePermission;
}

const DEFAULT_SETTINGS: SettingsFile = {
  probePermission: "yes",
};

async function filePath(): Promise<string> {
  const dir = await ensureConfigDir();
  return path.join(dir, "settings.json");
}

export async function loadSettings(): Promise<SettingsFile> {
  const fp = await filePath();
  return readJsonFile<SettingsFile>(fp, DEFAULT_SETTINGS);
}

export async function saveSettings(settings: SettingsFile): Promise<void> {
  const fp = await filePath();
  await writeJsonFile(fp, settings);
}
