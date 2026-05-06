import {
    formatLocalPortOccupiedMessage,
    inspectLocalPortOccupancy,
} from "./ports.ts";
import {
    buildRemoteBridgeRunArgs,
    checkRemoteUpstream,
    cleanupRemoteBridge,
    cleanupRemoteBridgeCommand,
    collectRemoteBridgeLogs,
    curlLocalRawUrl,
    curlRemoteBridge,
    detectRemoteDockerRunner,
    inspectRemoteBridge,
    makeBridgeContainerName,
    normalizeDockerBridgeRuntime,
    previewRemoteDockerCommand,
    selectRemoteBridgePort,
    startRemoteBridge,
    type FirstBrokenHop,
    type RemoteBridgeRuntime,
} from "./remote-docker-bridge.ts";
import { buildSshArgs, previewCommand } from "./tunnel-manager.ts";
import type { TunnelConfig } from "./types.ts";

interface DiagnosisReport {
    lines: string[];
    firstBrokenHop: FirstBrokenHop;
}

function section(lines: string[], title: string): void {
    lines.push("");
    lines.push(title);
}

function resultSummary(result: {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}): string {
    return [
        `ok=${result.ok}`,
        `exit=${result.code}`,
        result.timedOut ? "timedOut=yes" : "timedOut=no",
        `stdout=${JSON.stringify(result.stdout.slice(0, 500))}`,
        `stderr=${JSON.stringify(result.stderr.slice(0, 500))}`,
    ].join(" ");
}

async function startSshForDiagnosis(
    config: TunnelConfig,
): Promise<{
    process?: Bun.Subprocess;
    localListener: string;
    localRawCurl: Awaited<ReturnType<typeof curlLocalRawUrl>>;
    firstBrokenHop?: FirstBrokenHop;
}> {
    const sshArgs = buildSshArgs(config);
    const process = Bun.spawn(sshArgs, { stdout: "pipe", stderr: "pipe" });
    let exitedCode: number | null = null;
    void process.exited.then((code) => {
        exitedCode = code;
    });

    const bind = config.bindAddress || "127.0.0.1";
    const port = config.localPort!;
    let localListener = "not-listening";

    for (let attempt = 0; attempt < 25; attempt += 1) {
        if (exitedCode !== null) {
            process.kill();
            const localRawCurl = await curlLocalRawUrl(bind, port);
            return {
                process,
                localListener: `ssh exited early with code ${exitedCode}`,
                localRawCurl,
                firstBrokenHop: "ssh-bind-failed",
            };
        }
        const occupancy = await inspectLocalPortOccupancy(port, bind);
        if (!occupancy.available) {
            localListener = occupancy.occupant
                ? `listening by PID ${occupancy.occupant.pid ?? "?"}: ${occupancy.occupant.command ?? "unknown"}`
                : "listening";
            break;
        }
        await Bun.sleep(200);
    }

    if (localListener === "not-listening") {
        process.kill();
        const localRawCurl = await curlLocalRawUrl(bind, port);
        return {
            process,
            localListener,
            localRawCurl,
            firstBrokenHop: "ssh-bind-failed",
        };
    }

    const localRawCurl = await curlLocalRawUrl(bind, port);
    if (!localRawCurl.ok) {
        process.kill();
        return {
            process,
            localListener,
            localRawCurl,
            firstBrokenHop: "local-raw-url-failed",
        };
    }

    return { process, localListener, localRawCurl };
}

export async function diagnoseProfile(config: TunnelConfig): Promise<DiagnosisReport> {
    const lines: string[] = [];
    let firstBrokenHop: FirstBrokenHop = "none";
    let bridgeRuntime: RemoteBridgeRuntime | null = null;
    let sshProcess: Bun.Subprocess | undefined;
    const cleanupActions: string[] = [];

    lines.push("loaded profile");
    lines.push(`name=${config.name}`);
    lines.push(`target=${config.target.alias ?? config.target.destination}`);

    section(lines, "normalized runtime config");
    lines.push(`mode=${config.mode}`);
    lines.push(`bind=${config.bindAddress || "127.0.0.1"}`);
    lines.push(`localPort=${config.localPort ?? "-"}`);
    lines.push(`remoteHost=${config.remoteHost ?? "-"}`);
    lines.push(`remotePort=${config.remotePort ?? "-"}`);
    lines.push(
        `dockerBridge=${config.dockerBridge?.enabled ? "enabled" : "disabled"}`,
    );

    section(lines, "local port preflight");
    if (!config.localPort) {
        lines.push("localPort missing");
        firstBrokenHop = "local-port-occupied";
        lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
        return { lines, firstBrokenHop };
    }

    const bind = config.bindAddress || "127.0.0.1";
    const local = await inspectLocalPortOccupancy(config.localPort, bind);
    if (!local.available) {
        const occupant = local.occupant;
        lines.push(`available=no bind=${bind} port=${config.localPort}`);
        lines.push(`pid=${occupant?.pid ?? "-"}`);
        lines.push(`command=${occupant?.command ?? "process details unavailable"}`);
        lines.push(`appearsSshTunnel=${occupant?.isSshTunnel ? "yes" : "no"}`);
        lines.push(
            `action=${formatLocalPortOccupiedMessage(bind, config.localPort, occupant)}`,
        );
        firstBrokenHop = "local-port-occupied";
        lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
        return { lines, firstBrokenHop };
    }
    lines.push(`available=yes bind=${bind} port=${config.localPort}`);

    if (config.dockerBridge?.enabled) {
        const normalized = normalizeDockerBridgeRuntime(config);

        section(lines, "selected remote Docker prefix");
        const docker = await detectRemoteDockerRunner(normalized.sshTarget);
        for (const attempt of docker.attempts) {
            lines.push(`${attempt.command}`);
            lines.push(resultSummary(attempt));
        }
        if (!docker.ok) {
            firstBrokenHop = "remote-docker-unavailable";
            lines.push(
                "Remote Docker is required for this profile's Docker bridge, but the SSH user cannot run docker directly or via passwordless sudo.",
            );
            lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
            return { lines, firstBrokenHop };
        }
        lines.push(`selected=${docker.runner.label}`);

        section(lines, "remote upstream check");
        const upstream = await checkRemoteUpstream(normalized, docker.runner);
        lines.push(upstream.command);
        lines.push(resultSummary(upstream));
        if (!upstream.ok) {
            firstBrokenHop = "remote-upstream-unreachable";
            lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
            return { lines, firstBrokenHop };
        }

        section(lines, "selected remoteBridgePort");
        const selected = await selectRemoteBridgePort(normalized.sshTarget);
        lines.push(selected.command);
        lines.push(resultSummary(selected));
        if (!selected.ok || !selected.port) {
            firstBrokenHop = "remote-bridge-port-unavailable";
            lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
            return { lines, firstBrokenHop };
        }
        lines.push(`remoteBridgePort=${selected.port}`);

        bridgeRuntime = {
            ...normalized,
            remoteDocker: docker.runner,
            remoteBridgePort: selected.port,
            bridgeContainerName: makeBridgeContainerName(normalized.profileSlug),
        };

        section(lines, "remote bridge command");
        lines.push(
            previewRemoteDockerCommand(
                bridgeRuntime.sshTarget,
                bridgeRuntime.remoteDocker,
                buildRemoteBridgeRunArgs(bridgeRuntime, { removeOnExit: false }),
            ),
        );
        const started = await startRemoteBridge(bridgeRuntime, {
            removeOnExit: false,
        });
        lines.push(resultSummary(started));
        lines.push(`cleanup=${cleanupRemoteBridgeCommand(bridgeRuntime)}`);
        if (!started.ok) {
            firstBrokenHop = "remote-bridge-start-failed";
            cleanupActions.push(
                `left bridge container for inspection: ${cleanupRemoteBridgeCommand(bridgeRuntime)}`,
            );
            lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
            return { lines, firstBrokenHop };
        }

        section(lines, "remote bridge container status");
        const status = await inspectRemoteBridge(bridgeRuntime);
        lines.push(status.command);
        lines.push(resultSummary(status));
        lines.push(`status=${status.stdout || status.stderr || "-"}`);

        section(lines, "remote bridge curl result");
        const bridgeCurl = await curlRemoteBridge(bridgeRuntime);
        lines.push(bridgeCurl.command);
        lines.push(resultSummary(bridgeCurl));
        if (!bridgeCurl.ok) {
            const collected = await collectRemoteBridgeLogs(bridgeRuntime);
            lines.push(`docker logs: ${resultSummary(collected.logs)}`);
            lines.push(`docker inspect: ${resultSummary(collected.inspect)}`);
            firstBrokenHop = "remote-bridge-port-unreachable";
            cleanupActions.push(
                `left bridge container for inspection: ${cleanupRemoteBridgeCommand(bridgeRuntime)}`,
            );
            section(lines, "cleanup actions taken");
            lines.push(...cleanupActions);
            lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
            return { lines, firstBrokenHop };
        }

        config.remoteHost = "127.0.0.1";
        config.remotePort = bridgeRuntime.remoteBridgePort;
    }

    section(lines, "SSH command");
    lines.push(previewCommand(config));

    const ssh = await startSshForDiagnosis(config);
    sshProcess = ssh.process;

    section(lines, "local listener result");
    lines.push(ssh.localListener);

    section(lines, "local raw curl result");
    lines.push(`url=${ssh.localRawCurl.url}`);
    lines.push(resultSummary(ssh.localRawCurl));

    if (ssh.firstBrokenHop) {
        firstBrokenHop = ssh.firstBrokenHop;
        if (bridgeRuntime) {
            const cleanup = await cleanupRemoteBridge(bridgeRuntime);
            cleanupActions.push(
                `removed remote bridge ${bridgeRuntime.bridgeContainerName}: ${resultSummary(cleanup)}`,
            );
        }
    }

    if (!ssh.firstBrokenHop) {
        firstBrokenHop = "none";
        if (sshProcess) {
            sshProcess.kill();
            cleanupActions.push("stopped diagnostic SSH process");
        }
        if (bridgeRuntime) {
            const cleanup = await cleanupRemoteBridge(bridgeRuntime);
            cleanupActions.push(
                `removed remote bridge ${bridgeRuntime.bridgeContainerName}: ${resultSummary(cleanup)}`,
            );
        }
    }

    section(lines, "cleanup actions taken");
    lines.push(...(cleanupActions.length > 0 ? cleanupActions : ["none"]));
    lines.push(`FIRST_BROKEN_HOP=${firstBrokenHop}`);
    return { lines, firstBrokenHop };
}

export async function runDiagnose(config: TunnelConfig): Promise<number> {
    const report = await diagnoseProfile(config);
    for (const line of report.lines) console.log(line);
    return report.firstBrokenHop === "none" ? 0 : 1;
}
