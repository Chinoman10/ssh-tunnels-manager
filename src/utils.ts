import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { $ } from "bun";

export interface ExecResult {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export async function execCommand(
    cmd: string[],
    timeoutMs = 3_000,
): Promise<ExecResult> {
    let proc: Bun.Subprocess;
    try {
        proc = Bun.spawn(cmd, {
            stdout: "pipe",
            stderr: "pipe",
        });
    } catch (error) {
        return {
            ok: false,
            code: 127,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            timedOut: false,
        };
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);

    const stdoutStream =
        proc.stdout instanceof ReadableStream ? proc.stdout : undefined;
    const stderrStream =
        proc.stderr instanceof ReadableStream ? proc.stderr : undefined;
    const [stdout, stderr] = await Promise.all([
        stdoutStream ? new Response(stdoutStream).text() : "",
        stderrStream ? new Response(stderrStream).text() : "",
    ]);
    const code = await proc.exited;
    clearTimeout(timeout);

    return {
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
    };
}

export function makeId(prefix: string): string {
    const seed = `${prefix}:${Date.now()}:${Math.random()}`;
    return `${prefix}-${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

export function getConfigDir(): string {
    return path.join(os.homedir(), ".config", "ssh-tunnels-manager");
}

export async function ensureConfigDir(): Promise<string> {
    const dir = getConfigDir();
    await Bun.$`mkdir -p ${dir}`.quiet();
    return dir;
}

export async function readJsonFile<T>(
    filePath: string,
    fallback: T,
): Promise<T> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        return fallback;
    }
    try {
        return (await file.json()) as T;
    } catch {
        return fallback;
    }
}

export async function writeJsonFile(
    filePath: string,
    value: unknown,
): Promise<void> {
    await Bun.write(filePath, JSON.stringify(value, null, 2));
}

export function splitShellArgs(raw: string): string[] {
    if (!raw.trim()) return [];
    return raw
        .split(" ")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function coercePort(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
        return undefined;
    }
    return parsed;
}

export interface SpinnerHandle {
    stop: (finalMessage?: string) => void;
    update: (message: string) => void;
}

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

export function startSpinner(
    setStatus: (text: string) => void,
    initialMessage: string,
    intervalMs = 120,
): SpinnerHandle {
    let frameIndex = 0;
    let currentMessage = initialMessage;
    let stopped = false;

    const render = () => {
        if (stopped) return;
        setStatus(
            `${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!} ${currentMessage}`,
        );
        frameIndex += 1;
    };

    render();
    const timer = setInterval(render, intervalMs);

    return {
        stop: (finalMessage?: string) => {
            stopped = true;
            clearInterval(timer);
            if (finalMessage !== undefined) {
                setStatus(finalMessage);
            }
        },
        update: (message: string) => {
            currentMessage = message;
            render();
        },
    };
}

export function buildSshDockerCommand(
    target: string,
    dockerArgs: string[],
): string[] {
    const quote = (value: string) =>
        /^[a-zA-Z0-9_./:=@%+-]+$/.test(value)
            ? value
            : `'${value.replaceAll("'", "'\\''")}'`;
    const remoteCommand = ["docker", ...dockerArgs].map(quote).join(" ");
    return [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        target,
        remoteCommand,
    ];
}

// ── Bun Shell helper for diagnostic commands ──

export interface ShellResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

// Use directly: await $`cmd`.nothrow().quiet()
// This helper wraps a single-command string execution

export async function sh(command: string): Promise<ShellResult> {
    const result = await $`${{ raw: command }}`.nothrow().quiet();
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString().trim(),
        stderr: result.stderr.toString().trim(),
    };
}

// ── Structured logging ──

export type LogLevel = "debug" | "info" | "warn" | "error" | "cmd";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
}

const DOCKER_PERMISSION_RE =
    /permission denied.*docker|Got permission denied.*daemon socket|dial unix.*docker\.sock.*permission denied/i;

export async function execRemoteDockerCommand(
    target: string,
    dockerArgs: string[],
    timeoutMs = 10_000,
): Promise<ExecResult & { usedSudo: boolean }> {
    // First attempt: without sudo
    const first = await execCommand(
        buildSshDockerCommand(target, dockerArgs),
        timeoutMs,
    );

    if (first.ok) {
        return { ...first, usedSudo: false };
    }

    // Check if the failure looks like a Docker socket permission issue
    const combined = `${first.stderr} ${first.stdout}`;
    if (DOCKER_PERMISSION_RE.test(combined)) {
        const retry = await execCommand(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                target,
                ["sudo", "-n", "docker", ...dockerArgs]
                    .map((value) =>
                        /^[a-zA-Z0-9_./:=@%+-]+$/.test(value)
                            ? value
                            : `'${value.replaceAll("'", "'\\''")}'`,
                    )
                    .join(" "),
            ],
            timeoutMs,
        );
        return { ...retry, usedSudo: true };
    }

    return { ...first, usedSudo: false };
}
