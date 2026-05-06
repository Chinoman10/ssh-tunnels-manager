import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { TunnelConfig } from "./types.ts";
import {
    execCommand,
    execRemoteDockerCommand,
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
    localBind: string;
    localPort?: number;
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
    private dockerContainerName: string | null = null;
    private hintedConnectionRefused = false;
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
        let localUrl: string;
        let localBind: string;

        if (mode === "D") {
            localBind = `socks5://${bind}:${port}`;
            localUrl = localBind;
        } else {
            localBind = `${bind}:${port}`;
            // Named .localhost URL — port omitted if local Caddy is on 80
            const caddyPort = this.localCaddyPort || 8080;
            const portSuffix = caddyPort === 80 ? "" : `:${caddyPort}`;
            localUrl = `http://${hostname}${portSuffix}`;
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
            localBind,
            localPort: port,
        };
    }

    async start(): Promise<void> {
        this.stoppedByUser = false;
        this.structured("info", `profile loaded: ${this.config.name}`);
        this.structured(
            "debug",
            `normalized config: target=${this.config.target.alias ?? this.config.target.destination}, mode=${this.config.mode}, local=${this.config.bindAddress}:${this.config.localPort}, remote=${this.config.remoteHost ?? "?"}:${this.config.remotePort ?? "?"}, dockerBridge=${this.config.dockerBridge?.enabled ? `yes (networks: ${this.config.dockerBridge.networks.join(",")}, upstream: ${this.config.dockerBridge.upstreamTarget ?? "auto"})` : "no"}`,
        );
        if (this.config.dockerBridge?.enabled) {
            await this.startDockerBridge();
        }
        void this.spawnTunnel();
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

    private async startDockerBridge(): Promise<void> {
        const bridge = this.config.dockerBridge;
        if (!bridge?.enabled) return;

        const sshDest = this.getSshDestination();
        const name = `${bridge.containerNamePrefix}-${this.config.id}`.replace(
            /[^a-zA-Z0-9-]/g,
            "",
        );
        this.dockerContainerName = name;
        this.structured("info", `bridge: container name ${name}`);

        // Remove any existing container with the same name on the remote host
        await execRemoteDockerCommand(sshDest, ["rm", "-f", name], 5_000);

        const remotePort = this.config.remotePort ?? 9443;
        const bridgePort = remotePort;
        const remoteHost = this.config.remoteHost ?? "127.0.0.1";

        // Determine the proxy target for Caddy:
        // 1. Explicit upstreamTarget from config (populated by wizard from compose labels)
        // 2. If networks are specified, derive from network name (last resort)
        // 3. Otherwise, use the original remoteHost:remotePort
        let proxyTarget: string;
        let upstreamSource: string;

        if (bridge.upstreamTarget) {
            proxyTarget = bridge.upstreamTarget;
            upstreamSource = "explicit config";
        } else if (bridge.networks.length > 0) {
            const firstNetwork = bridge.networks[0]!;
            const serviceName = firstNetwork.replace(/_default$/, "");
            proxyTarget = `${serviceName}:${remotePort}`;
            upstreamSource = `network-derived (${firstNetwork}) [WARNING: guessing from network name]`;
        } else {
            proxyTarget = `${remoteHost}:${remotePort}`;
            upstreamSource = "direct remote";
        }

        this.structured(
            "info",
            `bridge: upstream target ${proxyTarget} (source: ${upstreamSource})`,
        );
        const caddyCmd = `caddy reverse-proxy --from :80 --to ${proxyTarget}`;
        this.structured("cmd", `bridge: ${caddyCmd}`);
        const dockerRunArgs: string[] = [
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "-p",
            `127.0.0.1:${bridgePort}:80`,
        ];

        if (bridge.networks.length > 0) {
            dockerRunArgs.push("--network", bridge.networks[0]!);
        }

        dockerRunArgs.push("caddy:2-alpine", "sh", "-c", caddyCmd);

        // ── Preflight: check upstream reachability from a temp container ──
        this.emit(
            "log",
            this.config.id,
            `Docker bridge: verifying upstream ${proxyTarget}...`,
        );
        const pfResult = await execRemoteDockerCommand(
            sshDest,
            [
                "run",
                "--rm",
                "--network",
                bridge.networks[0] ?? "host",
                "alpine/curl:latest",
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "--connect-timeout",
                "5",
                `http://${proxyTarget}`,
            ],
            15_000,
        );
        if (pfResult.ok) {
            this.structured(
                "info",
                `bridge: upstream ${proxyTarget} responded HTTP ${pfResult.stdout}`,
            );
        } else {
            this.structured(
                "warn",
                `bridge: upstream ${proxyTarget} preflight failed: ${pfResult.stderr || pfResult.stdout || "timeout/no response"}`,
            );
        }

        const result = await execRemoteDockerCommand(
            sshDest,
            dockerRunArgs,
            12_000,
        );

        if (!result.ok) {
            this.emit(
                "log",
                this.config.id,
                `Docker bridge: remote caddy container failed to start: ${result.stderr || result.stdout}`,
            );
            return;
        }

        // Connect to remaining networks
        for (const network of bridge.networks.slice(1)) {
            const connectResult = await execRemoteDockerCommand(
                sshDest,
                ["network", "connect", network, name],
                8_000,
            );
            if (!connectResult.ok) {
                this.emit(
                    "log",
                    this.config.id,
                    `Docker bridge: could not connect "${name}" to network "${network}": ${connectResult.stderr}`,
                );
            }
        }

        // Reroute the tunnel to go through Caddy on the remote host
        this.config.remoteHost = "127.0.0.1";
        this.config.remotePort = bridgePort;

        this.structured(
            "info",
            `bridge: caddy container started (${upstreamSource})`,
        );
        this.emit(
            "log",
            this.config.id,
            `Docker bridge: caddy sidecar "${name}" started on ${sshDest}${result.usedSudo ? " [sudo]" : ""} (${upstreamSource}).`,
        );
    }

    private async stopDockerBridge(): Promise<void> {
        if (!this.dockerContainerName) return;
        const sshDest = this.getSshDestination();
        await execRemoteDockerCommand(
            sshDest,
            ["rm", "-f", this.dockerContainerName],
            5_000,
        );
        this.dockerContainerName = null;
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
        void this.readStream(this.process.stdout, id);
        void this.readStream(this.process.stderr, id);

        const code = await this.process.exited;
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
    private localCaddy: Bun.Subprocess | null = null;
    private localCaddyPort = 8080;
    private localCaddyConfigPath = "";

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

        // Start/update local Caddy for named .localhost routing
        await this.ensureLocalCaddy();

        return session.snapshot;
    }

    async stop(id: string): Promise<void> {
        const session = this.sessions.get(id);
        if (!session) return;
        await session.stop();
        this.sessions.delete(id);
        await this.ensureLocalCaddy();
    }

    async stopAll(): Promise<void> {
        for (const id of this.sessions.keys()) {
            await this.stop(id);
        }
        await this.stopLocalCaddy();
    }

    list(): TunnelSessionSnapshot[] {
        return [...this.sessions.values()].map((s) => s.snapshot);
    }

    getLogs(id: string): string[] {
        return this.logs.get(id) ?? [];
    }

    getStructuredLogs(id: string): LogEntry[] {
        return this.structuredLogs.get(id) ?? [];
    }

    // ── Local Caddy for named .localhost domains ──

    private static readonly CADDY_PORT_CANDIDATES = [
        80, 8080, 8081, 8888, 9080,
    ];

    private async findLocalCaddyPort(): Promise<{
        port: number;
        reason?: string;
    }> {
        // Try each candidate in order
        for (const port of TunnelManager.CADDY_PORT_CANDIDATES) {
            const available = await new Promise<boolean>((resolve) => {
                const server = createServer();
                server.once("error", (err: NodeJS.ErrnoException) => {
                    server.close();
                    if (err.code === "EACCES" || err.code === "EPERM") {
                        // Permission denied on port 80 — don't try further low ports
                        if (port === 80) {
                            this.emit(
                                "log",
                                "manager",
                                "Local Caddy: port 80 requires elevated permissions. Falling back.",
                            );
                        }
                        resolve(false);
                    } else {
                        resolve(false); // EADDRINUSE or other
                    }
                });
                server.once("listening", () => {
                    server.close();
                    resolve(true);
                });
                server.listen(port, "127.0.0.1");
            });

            if (available) {
                return { port };
            }
        }

        // Dynamic scan upward from 10080
        for (let port = 10080; port <= 10180; port++) {
            const available = await new Promise<boolean>((resolve) => {
                const server = createServer();
                server.once("error", () => {
                    server.close();
                    resolve(false);
                });
                server.once("listening", () => {
                    server.close();
                    resolve(true);
                });
                server.listen(port, "127.0.0.1");
            });
            if (available) {
                return { port, reason: "fallback dynamic" };
            }
        }

        return { port: 8080, reason: "all ports busy, defaulting to 8080" };
    }

    private async ensureLocalCaddy(): Promise<void> {
        const sessions = this.list();
        if (sessions.length === 0) {
            await this.stopLocalCaddy();
            return;
        }

        // Only find port if we don't already have a working Caddy
        if (!this.localCaddy) {
            const { port, reason } = await this.findLocalCaddyPort();
            this.localCaddyPort = port;
            if (reason) {
                this.emit("log", "manager", `Local Caddy: ${reason}`);
            }
        }

        // Build Caddyfile with bind 127.0.0.1 and hostname:port site addresses
        const siteBlocks = sessions
            .filter((s) => s.localPort)
            .map((s) => {
                const hostname = `${s.name.replace(/[^a-zA-Z0-9-]/g, "-")}.localhost`;
                const portSuffix =
                    this.localCaddyPort === 80 ? "" : `:${this.localCaddyPort}`;
                return `http://${hostname}${portSuffix} {
    bind 127.0.0.1
    reverse_proxy 127.0.0.1:${s.localPort}
}`;
            });

        if (siteBlocks.length === 0) return;

        const caddyfile = `{
    admin off
    auto_https off
}

${siteBlocks.join("\n\n")}
`;

        // Write Caddyfile
        const tmpDir = Bun.env.TMPDIR || Bun.env.TMP || "/tmp";
        const configName = `stm-local-caddy-${Date.now()}.Caddyfile`;
        this.localCaddyConfigPath = `${tmpDir}/${configName}`;
        await Bun.write(this.localCaddyConfigPath, caddyfile);

        // Stop existing local Caddy
        if (this.localCaddy) {
            this.localCaddy.kill();
            this.localCaddy = null;
        }

        // Start local Caddy
        this.localCaddy = Bun.spawn(
            [
                "caddy",
                "run",
                "--config",
                this.localCaddyConfigPath,
                "--adapter",
                "caddyfile",
            ],
            { stdout: "pipe", stderr: "pipe" },
        );

        // Update session URLs with the actual port
        for (const id of this.sessions.keys()) {
            const session = this.sessions.get(id);
            if (session) {
                session.localCaddyPort = this.localCaddyPort;
            }
        }

        this.emit(
            "log",
            "manager",
            `Local Caddy listening on 127.0.0.1:${this.localCaddyPort} with ${siteBlocks.length} route(s).`,
        );
    }

    private async stopLocalCaddy(): Promise<void> {
        if (this.localCaddy) {
            this.localCaddy.kill();
            this.localCaddy = null;
        }
        if (this.localCaddyConfigPath) {
            try {
                await Bun.file(this.localCaddyConfigPath).delete();
            } catch {
                // ignore
            }
            this.localCaddyConfigPath = "";
        }
    }

    getLocalCaddyPort(): number {
        return this.localCaddyPort;
    }
}

export function buildSshArgs(config: TunnelConfig): string[] {
    const destination = config.target.alias ?? config.target.destination;
    const args: string[] = ["ssh", "-N"];

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
