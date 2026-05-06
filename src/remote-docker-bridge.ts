import type { TunnelConfig } from "./types.ts";
import { execCommand, makeId, type ExecResult } from "./utils.ts";

export type FirstBrokenHop =
    | "local-port-occupied"
    | "remote-docker-unavailable"
    | "remote-upstream-unreachable"
    | "remote-bridge-port-unavailable"
    | "remote-bridge-start-failed"
    | "remote-bridge-port-unreachable"
    | "ssh-bind-failed"
    | "local-raw-url-failed"
    | "none";

export interface RemoteDockerRunner {
    label: "docker" | "sudo -n docker";
    argv: string[];
}

export interface NormalizedDockerBridgeRuntime {
    sshTarget: string;
    profileSlug: string;
    network: string;
    upstreamTarget: string;
    localBindAddress: string;
    localPort: number;
}

export interface RemoteBridgeRuntime extends NormalizedDockerBridgeRuntime {
    remoteDocker: RemoteDockerRunner;
    remoteBridgePort: number;
    bridgeContainerName: string;
}

export interface RemoteCommandResult extends ExecResult {
    command: string;
}

function quoteForPreview(value: string): string {
    if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function preview(args: string[]): string {
    return args.map(quoteForPreview).join(" ");
}

export function getSshDestination(config: TunnelConfig): string {
    return config.target.alias ?? config.target.destination;
}

export function slugifyProfileName(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "profile";
}

export function normalizeDockerBridgeRuntime(
    config: TunnelConfig,
): NormalizedDockerBridgeRuntime {
    const bridge = config.dockerBridge;
    if (!bridge?.enabled) {
        throw new Error("Docker bridge is not enabled for this profile.");
    }
    if (!config.localPort) {
        throw new Error("Local port is required for Docker bridge profiles.");
    }

    const network = bridge.networks[0];
    if (!network) {
        throw new Error("Docker bridge requires at least one Docker network.");
    }

    const upstreamTarget =
        bridge.upstreamTarget ??
        `${network.replace(/_default$/, "")}:${config.remotePort ?? 80}`;

    return {
        sshTarget: getSshDestination(config),
        profileSlug: slugifyProfileName(config.name),
        network,
        upstreamTarget,
        localBindAddress: config.bindAddress || "127.0.0.1",
        localPort: config.localPort,
    };
}

export function makeBridgeContainerName(profileSlug: string): string {
    return `stm-remote-caddy-${profileSlug}-${makeId("b").replace(/^b-/, "")}`;
}

export function buildRemoteDockerSshArgs(
    target: string,
    runner: RemoteDockerRunner,
    dockerArgs: string[],
): string[] {
    const remoteCommand = preview([...runner.argv, ...dockerArgs]);
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

export function previewRemoteDockerCommand(
    target: string,
    runner: RemoteDockerRunner,
    dockerArgs: string[],
): string {
    return preview(buildRemoteDockerSshArgs(target, runner, dockerArgs));
}

export async function execRemoteDocker(
    target: string,
    runner: RemoteDockerRunner,
    dockerArgs: string[],
    timeoutMs = 10_000,
): Promise<RemoteCommandResult> {
    const command = buildRemoteDockerSshArgs(target, runner, dockerArgs);
    const result = await execCommand(command, timeoutMs);
    return { ...result, command: preview(command) };
}

async function execRemoteShell(
    target: string,
    command: string,
    timeoutMs = 10_000,
): Promise<RemoteCommandResult> {
    const args = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        target,
        command,
    ];
    const result = await execCommand(args, timeoutMs);
    return { ...result, command: preview(args) };
}

export async function detectRemoteDockerRunner(
    target: string,
): Promise<
    | { ok: true; runner: RemoteDockerRunner; attempts: RemoteCommandResult[] }
    | { ok: false; attempts: RemoteCommandResult[] }
> {
    const plain = await execRemoteShell(
        target,
        'docker ps --format "{{.ID}}" >/dev/null',
        10_000,
    );
    const plainSelection = selectRemoteDockerRunnerFromResults(plain);
    if (plainSelection) {
        return {
            ok: true,
            runner: plainSelection,
            attempts: [plain],
        };
    }

    const sudo = await execRemoteShell(
        target,
        'sudo -n docker ps --format "{{.ID}}" >/dev/null',
        10_000,
    );
    const sudoSelection = selectRemoteDockerRunnerFromResults(plain, sudo);
    if (sudoSelection) {
        return {
            ok: true,
            runner: sudoSelection,
            attempts: [plain, sudo],
        };
    }

    return { ok: false, attempts: [plain, sudo] };
}

export function selectRemoteDockerRunnerFromResults(
    plain: Pick<ExecResult, "ok">,
    sudo?: Pick<ExecResult, "ok">,
): RemoteDockerRunner | null {
    if (plain.ok) return { label: "docker", argv: ["docker"] };
    if (sudo?.ok) return { label: "sudo -n docker", argv: ["sudo", "-n", "docker"] };
    return null;
}

export function buildRemoteUpstreamCheckArgs(
    runtime: NormalizedDockerBridgeRuntime,
): string[] {
    return [
        "run",
        "--rm",
        "--network",
        runtime.network,
        "curlimages/curl:latest",
        "-fsS",
        "-o",
        "/dev/null",
        `http://${runtime.upstreamTarget}/`,
    ];
}

export async function checkRemoteUpstream(
    runtime: NormalizedDockerBridgeRuntime,
    runner: RemoteDockerRunner,
): Promise<RemoteCommandResult> {
    return execRemoteDocker(
        runtime.sshTarget,
        runner,
        buildRemoteUpstreamCheckArgs(runtime),
        30_000,
    );
}

export async function selectRemoteBridgePort(
    target: string,
    start = 41000,
    end = 41999,
): Promise<RemoteCommandResult & { port?: number }> {
    const command = `for p in $(seq ${start} ${end}); do if ! ss -ltn | awk '{print $4}' | grep -Eq '(^|:)'"$p"'$'; then echo "$p"; exit 0; fi; done; exit 1`;
    const result = await execRemoteShell(target, command, 10_000);
    const port = Number.parseInt(result.stdout.trim(), 10);
    return {
        ...result,
        port: Number.isFinite(port) ? port : undefined,
    };
}

export function buildRemoteBridgeRunArgs(
    runtime: RemoteBridgeRuntime,
    options?: { removeOnExit?: boolean },
): string[] {
    const args = [
        "run",
        "-d",
        "--name",
        runtime.bridgeContainerName,
        "-p",
        `127.0.0.1:${runtime.remoteBridgePort}:80`,
        "--network",
        runtime.network,
    ];
    if (options?.removeOnExit) {
        args.splice(2, 0, "--rm");
    }
    args.push(
        "caddy:2-alpine",
        "caddy",
        "reverse-proxy",
        "--from",
        ":80",
        "--to",
        runtime.upstreamTarget,
    );
    return args;
}

export async function startRemoteBridge(
    runtime: RemoteBridgeRuntime,
    options?: { removeOnExit?: boolean },
): Promise<RemoteCommandResult> {
    return execRemoteDocker(
        runtime.sshTarget,
        runtime.remoteDocker,
        buildRemoteBridgeRunArgs(runtime, options),
        20_000,
    );
}

export async function inspectRemoteBridge(
    runtime: RemoteBridgeRuntime,
): Promise<RemoteCommandResult> {
    return execRemoteDocker(
        runtime.sshTarget,
        runtime.remoteDocker,
        [
            "ps",
            "--filter",
            `name=${runtime.bridgeContainerName}`,
            "--format",
            "{{.Names}} {{.Status}} {{.Ports}}",
        ],
        10_000,
    );
}

export async function curlRemoteBridge(
    runtime: RemoteBridgeRuntime,
): Promise<RemoteCommandResult> {
    return execRemoteShell(
        runtime.sshTarget,
        `curl -fsS -o /dev/null http://127.0.0.1:${runtime.remoteBridgePort}/`,
        10_000,
    );
}

export async function collectRemoteBridgeLogs(
    runtime: RemoteBridgeRuntime,
): Promise<{ logs: RemoteCommandResult; inspect: RemoteCommandResult }> {
    const logs = await execRemoteDocker(
        runtime.sshTarget,
        runtime.remoteDocker,
        ["logs", "--tail", "80", runtime.bridgeContainerName],
        10_000,
    );
    const inspect = await execRemoteDocker(
        runtime.sshTarget,
        runtime.remoteDocker,
        ["inspect", runtime.bridgeContainerName],
        10_000,
    );
    return { logs, inspect };
}

export async function cleanupRemoteBridge(
    runtime: RemoteBridgeRuntime,
): Promise<RemoteCommandResult> {
    return execRemoteDocker(
        runtime.sshTarget,
        runtime.remoteDocker,
        ["rm", "-f", runtime.bridgeContainerName],
        10_000,
    );
}

export function cleanupRemoteBridgeCommand(runtime: RemoteBridgeRuntime): string {
    return previewRemoteDockerCommand(runtime.sshTarget, runtime.remoteDocker, [
        "rm",
        "-f",
        runtime.bridgeContainerName,
    ]);
}

export async function curlLocalRawUrl(
    bindAddress: string,
    port: number,
): Promise<ExecResult & { url: string }> {
    const url = `http://${bindAddress}:${port}/`;
    const result = await execCommand(
        ["curl", "-fsS", "-o", "/dev/null", url],
        10_000,
    );
    return { ...result, url };
}
