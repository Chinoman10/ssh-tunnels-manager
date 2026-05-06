import type { ReverseProxyDetection, TunnelTarget } from "./types.ts";
import { execCommand } from "./utils.ts";

function parseDomains(raw: string): string[] {
  const domains = new Set<string>();
  const regex = /([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/g;
  const matches = raw.match(regex) ?? [];
  for (const match of matches) {
    domains.add(match.toLowerCase());
  }
  return [...domains];
}

function buildProbeScript(): string {
  return [
    "set -e",
    "for path in /etc/nginx /etc/caddy /etc/traefik /opt/traefik /var/lib/docker/volumes; do",
    "  if [ -e \"$path\" ]; then",
    "    echo \"#CHECK:$path\"",
    "  fi",
    "done",
    "grep -RhoE '(server_name|Host\(|hosts?:)\\s*[^;\\n]+' /etc/nginx /etc/caddy /etc/traefik 2>/dev/null | head -n 200 || true",
    "grep -RhoE '([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}' /etc/nginx /etc/caddy /etc/traefik 2>/dev/null | head -n 200 || true",
  ].join("; ");
}

export async function detectReverseProxyDomains(
  target: TunnelTarget,
): Promise<ReverseProxyDetection> {
  const sshDestination = target.alias ?? target.destination;
  const command = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=4",
    sshDestination,
    buildProbeScript(),
  ];

  const result = await execCommand(command, 7_000);
  if (!result.ok) {
    return {
      found: false,
      domains: [],
      hints: ["Probe failed or timed out"],
      checked: [],
    };
  }

  const checked = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#CHECK:"))
    .map((line) => line.slice(7));

  const domains = parseDomains(result.stdout);
  return {
    found: domains.length > 0,
    domains,
    hints: ["Scanned Nginx/Caddy/Traefik paths"],
    checked,
  };
}
