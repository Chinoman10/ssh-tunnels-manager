import { CliFlags, ProbePermission, TunnelMode } from "./types.ts";
import { coercePort, splitShellArgs } from "./utils.ts";

const HELP_TEXT = `ssh-tunnels-manager\n\nUsage:\n  bun run src/index.ts [options]\n\nOptions:\n  --non-interactive           Run without TUI prompts\n  --target <alias|user@host>  SSH target alias or destination\n  --mode <L|R|D>              Tunnel mode (local, remote, dynamic)\n  --local-port <port>         Local bind port\n  --remote-host <host>        Remote host (default 127.0.0.1)\n  --remote-port <port>        Remote target port\n  --bind-address <ip>         Local bind address (default 127.0.0.1)\n  --ssh-extra \"...\"          Extra ssh args\n  --profile <name>            Launch from saved profile\n  --dry-run                   Print command and exit\n  --skip-preflight            Skip preflight checks\n  --auto-reconnect            Auto-restart when ssh exits\n  --docker-bridge             Enable docker bridge sidecar\n  --docker-network <name>     Add docker network (repeatable)\n  --reverse-domain <domain>   Force reverse proxy domain target\n  --probe-permission <yes|always|no>\n                              Probe behavior for remote reverse proxy checks\n  --help                      Show this help\n`;

export function parseFlags(argv: string[]): CliFlags {
  const defaults: CliFlags = {
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

    if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    if (arg === "--non-interactive") defaults.nonInteractive = true;
    else if (arg === "--skip-preflight") defaults.skipPreflight = true;
    else if (arg === "--dry-run") defaults.dryRun = true;
    else if (arg === "--auto-reconnect") defaults.autoReconnect = true;
    else if (arg === "--docker-bridge") defaults.dockerBridge = true;
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
