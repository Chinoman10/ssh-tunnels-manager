import { createServer } from "node:net";
import { execCommand } from "./utils.ts";

export interface PortCheckResult {
  available: boolean;
  error?: string;
}

export interface PortOccupant {
  pid?: number;
  command?: string;
  isSshTunnel: boolean;
  isLikelyManagedSession: boolean;
  raw: string;
}

export interface LocalPortOccupancy {
  available: boolean;
  error?: string;
  occupant?: PortOccupant;
}

export function formatLocalPortOccupiedMessage(
  bind: string,
  port: number,
  occupant?: PortOccupant,
): string {
  const pid = occupant?.pid ? `${occupant.pid}` : "<unknown>";
  const command = occupant?.command ?? "process details unavailable";
  const sshTunnel = occupant?.isSshTunnel
    ? " It appears to be an SSH tunnel."
    : "";
  return `Local port ${bind}:${port} is already in use by PID ${pid}: ${command}.${sshTunnel} Stop that process or choose another local port.`;
}

export async function checkLocalPort(
  port: number,
  host = "127.0.0.1",
): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const server = createServer();

    const cleanup = () => {
      server.removeAllListeners();
      server.close();
    };

    server.once("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      resolve({ available: false, error: err.code ?? err.message });
    });

    server.once("listening", () => {
      cleanup();
      resolve({ available: true });
    });

    server.listen(port, host);
  });
}

export async function suggestLocalPort(preferred: number): Promise<number> {
  if ((await checkLocalPort(preferred)).available) return preferred;

  for (let offset = 1; offset <= 200; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    if ((await checkLocalPort(candidate)).available) return candidate;
  }

  return preferred;
}

function toOccupant(raw: string, pid?: number, command?: string): PortOccupant {
  const cmd = command?.trim() ?? "";
  const isSshTunnel = /\bssh\b/.test(cmd) && /(?:^|\s)-(?:L|R|D)\s/.test(cmd);
  const isLikelyManagedSession =
    cmd.includes("ssh-tunnels-manager") || cmd.includes("stm-");
  return {
    pid,
    command: cmd || undefined,
    isSshTunnel,
    isLikelyManagedSession,
    raw,
  };
}

function parseSsOutput(stdout: string): PortOccupant | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^State\s+/i.test(line));
  if (lines.length === 0) return undefined;
  const line = lines[0]!;
  const users = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (users) {
    const command = users[1];
    const pid = Number.parseInt(users[2] ?? "", 10);
    return toOccupant(line, Number.isFinite(pid) ? pid : undefined, command);
  }
  return toOccupant(line);
}

function parseLsofOutput(stdout: string): PortOccupant | undefined {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const entry = lines.find((line) => !/^COMMAND\s+PID\s+/i.test(line));
  if (!entry) return undefined;

  const columns = entry.trim().split(/\s+/);
  const command = columns[0];
  const pid = Number.parseInt(columns[1] ?? "", 10);
  return toOccupant(
    entry,
    Number.isFinite(pid) ? pid : undefined,
    command,
  );
}

export async function inspectLocalPortOccupancy(
  port: number,
  host = "127.0.0.1",
): Promise<LocalPortOccupancy> {
  const check = await checkLocalPort(port, host);
  if (check.available) return { available: true };

  const ss = await execCommand(["ss", "-ltnp", "sport", "=", `:${port}`], 2_500);
  if (ss.ok && ss.stdout) {
    const occupant = parseSsOutput(ss.stdout);
    if (occupant) {
      let command = occupant.command;
      if (occupant.pid) {
        const ps = await execCommand(["ps", "-p", `${occupant.pid}`, "-o", "args="], 2_500);
        if (ps.ok && ps.stdout) {
          command = ps.stdout.trim();
        }
      }
      return {
        available: false,
        error: check.error,
        occupant: toOccupant(occupant.raw, occupant.pid, command),
      };
    }
  }

  const lsof = await execCommand(["lsof", "-nPi", `TCP@${host}:${port}`, "-sTCP:LISTEN"], 2_500);
  if (lsof.ok && lsof.stdout) {
    const occupant = parseLsofOutput(lsof.stdout);
    if (occupant) {
      return {
        available: false,
        error: check.error,
        occupant,
      };
    }
  }

  const lsofAnyHost = await execCommand(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], 2_500);
  if (lsofAnyHost.ok && lsofAnyHost.stdout) {
    const occupant = parseLsofOutput(lsofAnyHost.stdout);
    if (occupant) {
      return {
        available: false,
        error: check.error,
        occupant,
      };
    }
  }

  const fuser = await execCommand(["fuser", "-n", "tcp", `${port}`], 2_500);
  if (fuser.ok && fuser.stdout) {
    const pid = Number.parseInt(fuser.stdout.trim().split(/\s+/)[0] ?? "", 10);
    let command: string | undefined;
    if (Number.isFinite(pid)) {
      const ps = await execCommand(["ps", "-p", `${pid}`, "-o", "args="], 2_500);
      if (ps.ok && ps.stdout) command = ps.stdout.trim();
    }
    return {
      available: false,
      error: check.error,
      occupant: toOccupant(fuser.stdout, Number.isFinite(pid) ? pid : undefined, command),
    };
  }

  return {
    available: false,
    error: check.error ?? "busy",
  };
}
