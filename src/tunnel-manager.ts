import { EventEmitter } from "node:events";
import type { TunnelConfig } from "./types.ts";
import {
    formatLocalPortOccupiedMessage,
    inspectLocalPortOccupancy,
} from "./ports.ts";
import {
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
    type RemoteBridgeRuntime,
} from "./remote-docker-bridge.ts";
import {
    execCommand,
    sh,
    type LogEntry,
} from "./utils.ts";

export type SessionState =
    | "starting"
    | "running"
    | "reconnecting"
    | "stopped"
    | "failed";

export interface TunnelSessionSnapshot {
    id: string;
    name: string;
    state: SessionState;
    restartCount: number;
    pid?: number;
    lastError?: string;
    commandPreview: string;
    localUrl: string;
    localUrlFriendly?: string;
    localUrlRaw: string;
    localBind: string;
    localPort?: number;
    localCaddyStatus?: string;
    localCaddyMessage?: string;
}

interface TunnelSessionEvents {
    state: [TunnelSessionSnapshot];
    log: [string, string];
    structuredLog: [LogEntry];
}

class TunnelSession extends EventEmitter<TunnelSessionEvents> {
    private config: TunnelConfig;
    private process: Bun.Subprocess | null = null;
    private stoppedByUser = false;
    private restartCount = 0;
    private state: SessionState = "starting";
    private lastError = "";
    private bridgeRuntime: RemoteBridgeRuntime | null = null;
    private hintedConnectionRefused = false;
    private rawUrlVerified = false;
    localCaddyPort = 0;

    constructor(config: TunnelConfig) {
        super();
        this.config = config;
    }

    get snapshot(): TunnelSessionSnapshot {
        const bind = this.config.bindAddress || "127.0.0.1";
        const port = this.config.localPort;
        const mode = this.config.mode;
        const hostname = `${this.config.name.replace(/[^a-zA-Z0-9-]/g, "-")}.localhost`;
        const caddyPort = this.localCaddyPort;

        let localBind: string;
        let localUrlRaw: string;
        let localUrlFriendly: string | undefined;
        let localUrl: string;
        let localCaddyStatus: string | undefined;
        let localCaddyMessage: string | undefined;

        if (mode === "D") {
            localBind = `socks5://${bind}:${port}`;
            localUrlRaw = localBind;
            localUrl = localBind;
        } else {
            localBind = `${bind}:${port}`;
            localUrlRaw = `http://${bind}:${port}`;

            if (caddyPort > 0) {
                const portSuffix = caddyPort === 80 ? "" : `:${caddyPort}`;
                localUrlFriendly = `http://${hostname}${portSuffix}`;
                localUrl = localUrlFriendly;
                localCaddyStatus = "running";
            } else {
                localUrl = localUrlRaw;
                localCaddyStatus = "unavailable";
                localCaddyMessage =
                    "Local Caddy sidecar unavailable; friendly .localhost URL disabled.";
            }
        }

        return {
            id: this.config.id,
            name: this.config.name,
            state: this.state,
            restartCount: this.restartCount,
            pid: this.process?.pid,
            lastError: this.lastError || undefined,
            commandPreview: previewCommand(this.config),
            localUrl,
            localUrlFriendly,
            localUrlRaw,
            localBind,
            localPort: port,
            localCaddyStatus,
            localCaddyMessage,
        };
    }

    async start(): Promise<void> {
        this.stoppedByUser = false;
        this.rawUrlVerified = false;
        this.structured("info", `profile loaded: ${this.config.name}`);
        this.structured(
            "debug",
            `normalized config: target=${this.config.target.alias ?? this.config.target.destination}, mode=${this.config.mode}, local=${this.config.bindAddress}:${this.config.localPort}, remote=${this.config.remoteHost ?? "?"}:${this.config.remotePort ?? "?"}, dockerBridge=${this.config.dockerBridge?.enabled ? `yes (networks: ${this.config.dockerBridge.networks.join(",")}, upstream: ${this.config.dockerBridge.upstreamTarget ?? "auto"})` : "no"}`,
        );
        try {
            await this.preflightLocalBind();
            if (this.config.dockerBridge?.enabled) {
                await this.startDockerBridge();
            }
            await this.spawnTunnel();
            this.rawUrlVerified = true;
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.structured("error", this.lastError);
            this.state = "failed";
            this.emit("state", this.snapshot);
            if (this.process) {
                this.process.kill();
                this.process = null;
            }
            await this.stopDockerBridge();
        }
    }

    async stop(): Promise<void> {
        this.stoppedByUser = true;
        this.state = "stopped";
        this.emit("state", this.snapshot);

        if (this.process) {
            this.process.kill();
            this.process = null;
        }

        await this.stopDockerBridge();
    }

    get hasVerifiedRawUrl(): boolean {
        return this.rawUrlVerified;
    }

    private structured(level: LogEntry["level"], message: string): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            source: "manager",
            message,
        };
        this.emit("structuredLog", entry);
        this.emit("log", this.config.id, `[${level}] ${message}`);
    }

    private getSshDestination(): string {
        return this.config.target.alias ?? this.config.target.destination;
    }

    private async preflightLocalBind(): Promise<void> {
        if (!this.config.localPort || this.config.mode === "R") return;

        const bind = this.config.bindAddress || "127.0.0.1";
        const port = this.config.localPort;
        const result = await inspectLocalPortOccupancy(port, bind);
        if (result.available) {
            this.structured("info", `local port preflight ok: ${bind}:${port}`);
            return;
        }

        const occupant = result.occupant;
        throw new Error(
            `FIRST_BROKEN_HOP=local-port-occupied ${formatLocalPortOccupiedMessage(bind, port, occupant)}`,
        );
    }

    private async startDockerBridge(): Promise<void> {
        const normalized = normalizeDockerBridgeRuntime(this.config);
        this.structured(
            "info",
            `bridge: upstream target ${normalized.upstreamTarget} on network ${normalized.network}`,
        );

        const docker = await detectRemoteDockerRunner(normalized.sshTarget);
        if (!docker.ok) {
            throw new Error(
                "FIRST_BROKEN_HOP=remote-docker-unavailable Remote Docker is required for this profile's Docker bridge, but the SSH user cannot run docker directly or via passwordless sudo.",
            );
        }
        this.structured("info", `bridge: selected remote Docker prefix ${docker.runner.label}`);

        const upstream = await checkRemoteUpstream(normalized, docker.runner);
        if (!upstream.ok) {
            throw new Error(
                `FIRST_BROKEN_HOP=remote-upstream-unreachable Remote upstream check failed (exit ${upstream.code}): ${upstream.stderr || upstream.stdout || "no output"}`,
            );
        }
        this.structured("info", "bridge: remote upstream check ok");

        const selectedPort = await selectRemoteBridgePort(normalized.sshTarget);
        if (!selectedPort.ok || !selectedPort.port) {
            throw new Error(
                `FIRST_BROKEN_HOP=remote-bridge-port-unavailable No free remote loopback bridge port was found in 41000-41999 (${selectedPort.stderr || selectedPort.stdout || "no output"}).`,
            );
        }

        const runtime: RemoteBridgeRuntime = {
            ...normalized,
            remoteDocker: docker.runner,
            remoteBridgePort: selectedPort.port,
            bridgeContainerName: makeBridgeContainerName(normalized.profileSlug),
        };
        this.bridgeRuntime = runtime;
        this.structured(
            "info",
            `bridge: selected remoteBridgePort ${runtime.remoteBridgePort}`,
        );
        this.structured(
            "info",
            `bridge: container name ${runtime.bridgeContainerName}`,
        );
        this.structured(
            "cmd",
            `bridge: ${previewRemoteDockerCommand(runtime.sshTarget, runtime.remoteDocker, [
                "run",
                "-d",
                "--name",
                runtime.bridgeContainerName,
                "-p",
                `127.0.0.1:${runtime.remoteBridgePort}:80`,
                "--network",
                runtime.network,
                "caddy:2-alpine",
                "caddy",
                "reverse-proxy",
                "--from",
                ":80",
                "--to",
                runtime.upstreamTarget,
            ])}`,
        );

        const started = await startRemoteBridge(runtime, { removeOnExit: false });
        if (!started.ok) {
            throw new Error(
                `FIRST_BROKEN_HOP=remote-bridge-start-failed Remote Caddy bridge failed to start (exit ${started.code}): ${started.stderr || started.stdout || "no output"}. Cleanup: ${cleanupRemoteBridgeCommand(runtime)}`,
            );
        }

        const status = await inspectRemoteBridge(runtime);
        this.structured(
            status.ok && status.stdout ? "info" : "warn",
            `bridge: container status ${status.stdout || status.stderr || "not found"}`,
        );

        const bridgeCurl = await curlRemoteBridge(runtime);
        if (!bridgeCurl.ok) {
            const collected = await collectRemoteBridgeLogs(runtime);
            throw new Error(
                `FIRST_BROKEN_HOP=remote-bridge-port-unreachable Remote bridge curl failed (exit ${bridgeCurl.code}): ${bridgeCurl.stderr || bridgeCurl.stdout || "no output"}. Logs: ${collected.logs.stdout || collected.logs.stderr || "none"}. Inspect: ${collected.inspect.stdout.slice(0, 600) || collected.inspect.stderr || "none"}`,
            );
        }

        this.config.remoteHost = "127.0.0.1";
        this.config.remotePort = runtime.remoteBridgePort;
        this.structured("info", "bridge: remote loopback bridge verified");
    }

    private async stopDockerBridge(): Promise<void> {
        if (!this.bridgeRuntime) return;
        await cleanupRemoteBridge(this.bridgeRuntime);
        this.bridgeRuntime = null;
    }

    private async spawnTunnel(): Promise<void> {
        const sshArgs = buildSshArgs(this.config);
        this.structured("cmd", `tunnel: ${previewCommand(this.config)}`);
        this.state = this.restartCount === 0 ? "starting" : "reconnecting";
        this.emit("state", this.snapshot);

        this.process = Bun.spawn(sshArgs, {
            stdout: "pipe",
            stderr: "pipe",
        });

        this.state = "running";
        this.emit("state", this.snapshot);

        const id = this.config.id;
        if (this.process.stdout instanceof ReadableStream) {
            void this.readStream(this.process.stdout, id);
        }
        if (this.process.stderr instanceof ReadableStream) {
            void this.readStream(this.process.stderr, id);
        }

        let exitedCode: number | null = null;
        const exited = this.process.exited.then((code) => {
            exitedCode = code;
            return code;
        });

        const bind = this.config.bindAddress || "127.0.0.1";
        const port =
            this.config.mode === "D"
                ? (this.config.dynamicPort ?? this.config.localPort)
                : this.config.localPort;

        for (let attempt = 0; attempt < 25; attempt += 1) {
            if (exitedCode !== null) {
                throw new Error(
                    `FIRST_BROKEN_HOP=ssh-bind-failed ssh exited early with code ${exitedCode}`,
                );
            }
            if (port && !(await inspectLocalPortOccupancy(port, bind)).available) {
                break;
            }
            await Bun.sleep(200);
        }

        if (exitedCode !== null) {
            throw new Error(
                `FIRST_BROKEN_HOP=ssh-bind-failed ssh exited early with code ${exitedCode}`,
            );
        }

        const requiresRawHttpVerification =
            this.config.mode !== "D" && this.config.dockerBridge?.enabled;
        if (requiresRawHttpVerification && port) {
            const raw = await curlLocalRawUrl(bind, port);
            if (!raw.ok) {
                if (this.bridgeRuntime) {
                    const remoteCurl = await curlRemoteBridge(this.bridgeRuntime);
                    const collected = await collectRemoteBridgeLogs(
                        this.bridgeRuntime,
                    );
                    throw new Error(
                        `FIRST_BROKEN_HOP=local-raw-url-failed Local raw URL ${raw.url} failed (exit ${raw.code}): ${raw.stderr || raw.stdout || "no output"}. Remote bridge curl: ${remoteCurl.ok ? "ok" : remoteCurl.stderr || remoteCurl.stdout || "failed"}. Bridge logs: ${collected.logs.stdout || collected.logs.stderr || "none"}`,
                    );
                }
                throw new Error(
                    `FIRST_BROKEN_HOP=local-raw-url-failed Local raw URL ${raw.url} failed (exit ${raw.code}): ${raw.stderr || raw.stdout || "no output"}`,
                );
            }
            this.structured("info", `local raw URL verified: ${raw.url}`);
        } else if (port) {
            this.structured("info", `local listener verified: ${bind}:${port}`);
        }

        void this.monitorProcess(exited, id);
    }

    private async monitorProcess(exited: Promise<number>, id: string): Promise<void> {
        const code = await exited;
        this.process = null;

        if (this.stoppedByUser) {
            this.state = "stopped";
            this.emit("state", this.snapshot);
            return;
        }

        this.lastError = `ssh exited with code ${code}`;
        this.emit("log", id, this.lastError);

        if (this.config.autoReconnect) {
            this.restartCount += 1;
            const delayMs = Math.min(8_000, 1_000 + this.restartCount * 700);
            await Bun.sleep(delayMs);
            await this.spawnTunnel();
            return;
        }

        this.state = "failed";
        this.emit("state", this.snapshot);
    }

    private async readStream(
        stream: ReadableStream<Uint8Array>,
        id: string,
    ): Promise<void> {
        const reader = stream.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = Buffer.from(value).toString("utf8").trim();
            if (!text) continue;

            this.emit("log", id, text);

            if (
                /connection refused/i.test(text) &&
                !this.hintedConnectionRefused
            ) {
                this.hintedConnectionRefused = true;
                const remote = `${this.config.remoteHost ?? "127.0.0.1"}:${this.config.remotePort ?? "?"}`;
                const hints = [
                    `Hint: Connection refused to ${remote}.`,
                    `  → Is the service running on the remote host?`,
                    `  → Is it listening on ${this.config.remoteHost ?? "127.0.0.1"}? Try "0.0.0.0" or the container's network IP.`,
                    `  → If behind Docker, enable Docker bridge and attach to the right network.`,
                    `  → Run "ssh ${this.config.target.alias ?? this.config.target.destination} docker ps" to see running containers.`,
                ];
                for (const hint of hints) {
                    this.emit("log", id, hint);
                }
            }

            if (
                /channel .*open failed/i.test(text) &&
                !this.hintedConnectionRefused
            ) {
                this.emit(
                    "log",
                    id,
                    "Hint: SSH channel could not be opened. Verify the remote host:port is reachable from the SSH server.",
                );
            }
        }
    }
}

export class TunnelManager extends EventEmitter<TunnelSessionEvents> {
    private sessions = new Map<string, TunnelSession>();
    private logs = new Map<string, string[]>();
    private structuredLogs = new Map<string, LogEntry[]>();
    private localCaddy = new LocalCaddyManager(this);

    async start(config: TunnelConfig): Promise<TunnelSessionSnapshot> {
        const session = new TunnelSession(config);
        this.sessions.set(config.id, session);
        this.logs.set(config.id, []);
        this.structuredLogs.set(config.id, []);

        session.on("state", (snapshot) => this.emit("state", snapshot));
        session.on("log", (id, line) => {
            const lines = this.logs.get(id) ?? [];
            lines.push(line);
            if (lines.length > 200) lines.shift();
            this.logs.set(id, lines);
            this.emit("log", id, line);
        });
        session.on("structuredLog", (entry) => {
            const entries = this.structuredLogs.get(config.id) ?? [];
            entries.push(entry);
            if (entries.length > 200) entries.shift();
            this.structuredLogs.set(config.id, entries);
        });

        await session.start();

        // Local friendly URLs are optional; do not start them until raw URL works.
        if (session.hasVerifiedRawUrl) {
            await this.localCaddy.ensureRunning();
        }

        return session.snapshot;
    }

    async stop(id: string): Promise<void> {
        const session = this.sessions.get(id);
        if (!session) return;
        await session.stop();
        this.sessions.delete(id);
        await this.localCaddy.ensureRunning();
    }

    async stopAll(): Promise<void> {
        for (const id of this.sessions.keys()) {
            await this.stop(id);
        }
        await this.localCaddy.stop();
    }

    list(): TunnelSessionSnapshot[] {
        return [...this.sessions.values()].map((s) => s.snapshot);
    }

    /** Exposes raw session for LocalCaddyManager port update */
    getSessionById(id: string): TunnelSession | undefined {
        return this.sessions.get(id);
    }

    getLogs(id: string): string[] {
        return this.logs.get(id) ?? [];
    }

    getStructuredLogs(id: string): LogEntry[] {
        return this.structuredLogs.get(id) ?? [];
    }

    getLocalCaddyPort(): number {
        return this.localCaddy.selectedPort;
    }
}

// ── Local Caddy Manager (Docker-based, ephemeral) ──

class LocalCaddyManager {
    private static readonly CONTAINER_NAME = "stm-local-caddy";
    private static readonly PORT_CANDIDATES = [80, 8080, 8081, 8888, 9080];
    private static readonly DYNAMIC_START = 10080;
    private static readonly DYNAMIC_END = 10180;

    selectedPort = 0;
    private configPath = "";
    private lastError = "";
    private upstreamUrl = "";
    private usedHostNetwork = false;

    constructor(private manager: TunnelManager) {}

    private log(msg: string): void {
        this.manager.emit("log", "manager", `Local Caddy: ${msg}`);
    }

    async ensureRunning(): Promise<void> {
        const sessions = this.manager
            .list()
            .filter((s) => s.state !== "stopped" && s.state !== "failed");

        if (sessions.length === 0) {
            await this.stop();
            return;
        }

        const first = sessions.find((s) => s.localPort);
        if (!first?.localPort) return;
        this.upstreamUrl = `http://host.docker.internal:${first.localPort}`;

        try {
            const dockerOk = await this.checkDocker();
            if (!dockerOk) {
                this.disable("Docker unavailable");
                return;
            }

            if (this.selectedPort === 0) {
                this.selectedPort = await this.probePort();
                if (this.selectedPort === 0) {
                    this.disable("No host port available");
                    return;
                }
            }

            // Try bridge mode first
            const bridgeOk = await this.tryStartContainer(false, sessions);
            if (bridgeOk) {
                this.usedHostNetwork = false;
                this.updateSessionPorts();
                return;
            }

            // Fallback: host networking
            this.log("Bridge mode failed; trying host networking...");
            await execCommand(
                ["docker", "rm", "-f", LocalCaddyManager.CONTAINER_NAME],
                3_000,
            );
            const hostOk = await this.tryStartContainer(true, sessions);
            if (hostOk) {
                this.usedHostNetwork = true;
                this.updateSessionPorts();
                return;
            }

            // Both failed
            await execCommand(
                ["docker", "rm", "-f", LocalCaddyManager.CONTAINER_NAME],
                3_000,
            );
            this.disable(
                this.lastError ||
                    "Local Caddy could not reach the local SSH listener.",
            );
        } catch (err) {
            this.disable(err instanceof Error ? err.message : String(err));
            await execCommand(
                ["docker", "rm", "-f", LocalCaddyManager.CONTAINER_NAME],
                3_000,
            );
        }
    }

    private disable(reason: string): void {
        this.log(reason);
        this.lastError = reason;
        this.selectedPort = 0;
        this.updateSessionPorts();
    }

    async stop(): Promise<void> {
        try {
            await execCommand(
                ["docker", "rm", "-f", LocalCaddyManager.CONTAINER_NAME],
                5_000,
            );
        } catch {
            /* ignore */
        }
        this.selectedPort = 0;
        this.lastError = "";
        this.upstreamUrl = "";
        this.usedHostNetwork = false;
        this.updateSessionPorts();
        await this.cleanupConfig();
    }

    private async checkDocker(): Promise<boolean> {
        return (await execCommand(["docker", "info", "--format", "ok"], 3_000))
            .ok;
    }

    private async tryStartContainer(
        hostNetwork: boolean,
        sessions: TunnelSessionSnapshot[],
    ): Promise<boolean> {
        const siteBlocks = sessions
            .filter((s) => s.localPort)
            .map((s) => {
                const hostname = `${s.name.replace(/[^a-zA-Z0-9-]/g, "-")}.localhost`;
                const upstream = hostNetwork
                    ? `127.0.0.1:${s.localPort}`
                    : `host.docker.internal:${s.localPort}`;
                return `http://${hostname} {
    bind 0.0.0.0
    reverse_proxy ${upstream}
}`;
            });

        const caddyfile = `{
    admin off
    auto_https off
}

${siteBlocks.join("\n\n")}
`;

        const tmpDir = Bun.env.TMPDIR || Bun.env.TMP || "/tmp";
        this.configPath = `${tmpDir}/stm-local-caddy-${Date.now()}.Caddyfile`;
        await Bun.write(this.configPath, caddyfile);

        await execCommand(
            ["docker", "rm", "-f", LocalCaddyManager.CONTAINER_NAME],
            5_000,
        );

        const dockerArgs: string[] = [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            LocalCaddyManager.CONTAINER_NAME,
        ];

        if (hostNetwork) {
            dockerArgs.push("--network", "host");
        } else {
            dockerArgs.push(
                "-p",
                `127.0.0.1:${this.selectedPort}:80`,
                "--add-host",
                "host.docker.internal:host-gateway",
            );
        }

        dockerArgs.push(
            "-v",
            `${this.configPath}:/etc/caddy/Caddyfile:ro`,
            "caddy:2-alpine",
            "caddy",
            "run",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        );

        const result = await execCommand(dockerArgs, 15_000);
        if (!result.ok) {
            this.lastError = `Container start failed: ${result.stderr.slice(0, 200)}`;
            this.log(this.lastError);
            return false;
        }

        await Bun.sleep(800);

        // Readiness: can Caddy reach upstream from inside?
        const upstream = hostNetwork
            ? `127.0.0.1:${sessions.find((s) => s.localPort)?.localPort ?? 9000}`
            : `host.docker.internal:${sessions.find((s) => s.localPort)?.localPort ?? 9000}`;

        const execResult = await execCommand(
            [
                "docker",
                "exec",
                LocalCaddyManager.CONTAINER_NAME,
                "wget",
                "-q",
                "-S",
                "-O",
                "-",
                "--timeout=4",
                `http://${upstream}/`,
            ],
            8_000,
        );

        if (!execResult.ok) {
            this.lastError = `Caddy cannot reach upstream ${upstream}: ${execResult.stderr.slice(0, 150)}`;
            this.log(this.lastError);
            return false;
        }

        // Readiness: can host reach Caddy?
        const hostCheck = await sh(
            `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 http://127.0.0.1:${this.selectedPort}/`,
        );
        if (!["200", "404", "502"].includes(hostCheck.stdout)) {
            this.lastError = `Host cannot reach Caddy on 127.0.0.1:${this.selectedPort} (HTTP ${hostCheck.stdout || hostCheck.exitCode})`;
            this.log(this.lastError);
            return false;
        }

        if (hostCheck.stdout === "502") {
            this.lastError = `Caddy returns 502 — upstream ${upstream} unreachable from container.`;
            this.log(this.lastError);
            return false;
        }

        this.log(
            `Ready on 127.0.0.1:${this.selectedPort} (${hostNetwork ? "host" : "bridge"} mode, ${siteBlocks.length} route(s)).`,
        );
        return true;
    }

    private async probePort(): Promise<number> {
        const candidates = [
            ...LocalCaddyManager.PORT_CANDIDATES,
            ...Array.from(
                {
                    length:
                        LocalCaddyManager.DYNAMIC_END -
                        LocalCaddyManager.DYNAMIC_START +
                        1,
                },
                (_, i) => LocalCaddyManager.DYNAMIC_START + i,
            ),
        ];

        for (const port of candidates) {
            const probeName = `stm-local-caddy-port-probe-${port}`;
            await execCommand(["docker", "rm", "-f", probeName], 2_000);

            const result = await execCommand(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--name",
                    probeName,
                    "-p",
                    `127.0.0.1:${port}:80`,
                    "caddy:2-alpine",
                    "caddy",
                    "respond",
                    "--listen",
                    ":80",
                    "--body",
                    "ok",
                ],
                15_000,
            );

            if (result.ok) {
                await Bun.sleep(400);
                const curl = await sh(
                    `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 http://127.0.0.1:${port}/`,
                );
                await execCommand(["docker", "rm", "-f", probeName], 3_000);
                if (curl.stdout === "200") {
                    this.log(`Selected port ${port}.`);
                    return port;
                }
                continue;
            }

            const stderr = result.stderr.toLowerCase();
            if (
                stderr.includes("port is already allocated") ||
                stderr.includes("bind: address already in use")
            )
                continue;
            if (
                (stderr.includes("permission denied") ||
                    stderr.includes("eacces")) &&
                port === 80
            ) {
                this.log(
                    "Port 80 requires elevated permissions. Falling back.",
                );
                continue;
            }
        }
        return 0;
    }

    private updateSessionPorts(): void {
        for (const snapshot of this.manager.list()) {
            const session = this.manager.getSessionById(snapshot.id);
            if (session) {
                session.localCaddyPort = this.selectedPort;
            }
        }
    }

    private async cleanupConfig(): Promise<void> {
        if (this.configPath) {
            try {
                await Bun.file(this.configPath).delete();
            } catch {
                // ignore
            }
            this.configPath = "";
        }
    }
}

export function buildSshArgs(config: TunnelConfig): string[] {
    const destination = config.target.alias ?? config.target.destination;
    const args: string[] = ["ssh", "-N", "-o", "ExitOnForwardFailure=yes"];

    if (config.mode === "L") {
        const bind = `${config.bindAddress}:${config.localPort}`;
        const remote = `${config.remoteHost}:${config.remotePort}`;
        args.push("-L", `${bind}:${remote}`);
    } else if (config.mode === "R") {
        const bind = `${config.bindAddress}:${config.localPort}`;
        const remote = `${config.remoteHost}:${config.remotePort}`;
        args.push("-R", `${bind}:${remote}`);
    } else {
        args.push(
            "-D",
            `${config.bindAddress}:${config.dynamicPort ?? config.localPort}`,
        );
    }

    args.push(...config.sshExtraArgs);
    args.push(destination);

    return args;
}

export function previewCommand(config: TunnelConfig): string {
    return buildSshArgs(config)
        .map((token) => (token.includes(" ") ? `"${token}"` : token))
        .join(" ");
}
