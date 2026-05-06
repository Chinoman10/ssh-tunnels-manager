import { readFile } from "node:fs/promises";
import { ServicePresetDocument } from "./types.ts";

let cache: ServicePresetDocument | null = null;

export async function loadServicePresets(): Promise<ServicePresetDocument> {
  if (cache) return cache;
  const fileUrl = new URL("../data/service-presets.json", import.meta.url);
  const raw = await readFile(fileUrl, "utf8");
  cache = JSON.parse(raw) as ServicePresetDocument;
  return cache;
}
