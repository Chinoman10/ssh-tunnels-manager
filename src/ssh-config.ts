import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshHostEntry } from "./types.ts";
import { execCommand } from "./utils.ts";

interface ParseContext {
  visited: Set<string>;
  hosts: SshHostEntry[];
}

function normalizePath(inputPath: string, parentDir: string): string {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(parentDir, inputPath);
}

async function parseFile(filePath: string, ctx: ParseContext): Promise<void> {
  if (ctx.visited.has(filePath)) return;
  ctx.visited.add(filePath);

  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  const dir = path.dirname(filePath);

  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;

    const includeMatch = line.match(/^Include\s+(.+)$/i);
    if (includeMatch) {
      const patterns = includeMatch[1]
        .split(/\s+/)
        .map((value) => normalizePath(value, dir));

      for (const pattern of patterns) {
        if (!pattern.includes("*") && !pattern.includes("?")) {
          await parseFile(pattern, ctx);
          continue;
        }

        const glob = new Bun.Glob(pattern);
        for await (const matched of glob.scan({ absolute: true, cwd: "/" })) {
          await parseFile(matched, ctx);
        }
      }
      continue;
    }

    const hostMatch = line.match(/^Host\s+(.+)$/i);
    if (!hostMatch) continue;

    const patterns = hostMatch[1].split(/\s+/).filter(Boolean);
    for (const alias of patterns) {
      const isWildcard = alias.includes("*") || alias.includes("?");
      ctx.hosts.push({
        alias,
        sourceFile: filePath,
        patterns,
        isWildcard,
      });
    }
  }
}

export async function loadSshAliases(): Promise<SshHostEntry[]> {
  const mainFile = path.join(os.homedir(), ".ssh", "config");
  const ctx: ParseContext = {
    visited: new Set<string>(),
    hosts: [],
  };
  await parseFile(mainFile, ctx);

  const unique = new Map<string, SshHostEntry>();
  for (const host of ctx.hosts) {
    if (!unique.has(host.alias)) unique.set(host.alias, host);
  }

  return [...unique.values()].sort((a, b) => {
    const aw = a.isWildcard ? 1 : 0;
    const bw = b.isWildcard ? 1 : 0;
    if (aw !== bw) return aw - bw;
    return a.alias.localeCompare(b.alias);
  });
}

export async function sshEffectiveConfig(alias: string): Promise<string[]> {
  const result = await execCommand(["ssh", "-G", alias], 4_000);
  if (!result.ok) return [];

  const keys = ["hostname", "user", "port", "identityfile", "proxyjump"];
  const summary: string[] = [];

  for (const raw of result.stdout.split(/\r?\n/)) {
    const [key, ...rest] = raw.split(" ");
    if (!keys.includes(key)) continue;
    summary.push(`${key} ${rest.join(" ").trim()}`);
  }

  return summary;
}
