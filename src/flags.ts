import type { CliFlags, ProbePermission, TunnelMode } from "./types.ts";
import { coercePort, splitShellArgs } from "./utils.ts";

const HELP_TEXT = `ssh-tunnels-manager

Usage:
  bun run src/index.ts [options]
  bun run src/index.ts diagnose [options]

Options:
  --non-interactive           Run without TUI prompts
  --target <alias|user@host>  SSH target alias or destination
  --mode <L|R|D>              Tunnel mode (local, remote, dynamic)
  --local-port <port>         Local bind port
  --remote-host <host>        Remote host (default 127.0.0.1)
  --remote-port <port>        Remote target port
  --bind-address <ip>         Local bind address (default 127.0.0.1)
  --ssh-extra "..."          Extra ssh args
  --profile <name>            Launch from saved profile
  --dry-run                   Print command and exit
  --skip-preflight            Skip preflight checks
  --auto-reconnect            Auto-restart when ssh exits
  --docker-bridge             Enable docker bridge sidecar
  --docker-network <name>     Add docker network (repeatable)
  --reverse-domain <domain>   Force reverse proxy domain target
  --probe-permission <yes|always|no>
                              Probe behavior for remote reverse proxy checks
  --replace-existing          Reserved for explicit future replacement flow
  --keep-failed-bridge        Keep failed remote bridge container for debugging
  --help                      Show this help
`;

export function parseFlags(argv: string[]): CliFlags {
  const defaults: CliFlags = {
    diagnose: false,
    nonInteractive: false,
    skipPreflight: false,
    dryRun: false,
    sshExtraArgs: [],
    dockerBridge: false,
    dockerNetworks: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (i === 0 && arg === "diagnose") {
      defaults.diagnose = true;
      defaults.nonInteractive = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    if (arg === "--non-interactive") defaults.nonInteractive = true;
    else if (arg === "--skip-preflight") defaults.skipPreflight = true;
    else if (arg === "--dry-run") defaults.dryRun = true;
    else if (arg === "--auto-reconnect") defaults.autoReconnect = true;
    else if (arg === "--docker-bridge") defaults.dockerBridge = true;
    else if (arg === "--replace-existing") defaults.replaceExisting = true;
    else if (arg === "--keep-failed-bridge") defaults.keepFailedBridgeContainer = true;
    else if (arg === "--target" && next) {
      defaults.target = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      defaults.profile = next;
      i += 1;
    } else if (arg === "--mode" && next) {
      if (["L", "R", "D"].includes(next)) defaults.mode = next as TunnelMode;
      i += 1;
    } else if (arg === "--local-port" && next) {
      defaults.localPort = coercePort(next);
      i += 1;
    } else if (arg === "--remote-host" && next) {
      defaults.remoteHost = next;
      i += 1;
    } else if (arg === "--remote-port" && next) {
      defaults.remotePort = coercePort(next);
      i += 1;
    } else if (arg === "--bind-address" && next) {
      defaults.bindAddress = next;
      i += 1;
    } else if (arg === "--reverse-domain" && next) {
      defaults.reverseDomain = next;
      i += 1;
    } else if (arg === "--probe-permission" && next) {
      if (["yes", "always", "no"].includes(next)) {
        defaults.probePermission = next as ProbePermission;
      }
      i += 1;
    } else if (arg === "--ssh-extra" && next) {
      defaults.sshExtraArgs.push(...splitShellArgs(next));
      i += 1;
    } else if (arg === "--docker-network" && next) {
      defaults.dockerNetworks.push(next);
      i += 1;
    }
  }

  return defaults;
}
