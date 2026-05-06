import { checkLocalPort } from "./ports.ts";
import type { TunnelConfig, PreflightIssue } from "./types.ts";
import { execCommand, sh } from "./utils.ts";

export interface DockerStatus {
    installed: boolean;
    accessible: boolean;
    detail: string;
}

export interface PreflightResult {
    issues: PreflightIssue[];
    docker: DockerStatus;
}

export async function checkDockerStatus(): Promise<DockerStatus> {
    const which = await execCommand(["docker", "--version"], 2_500);
    if (!which.ok) {
        return {
            installed: false,
            accessible: false,
            detail: "Docker CLI not found",
        };
    }

    const info = await execCommand(
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        3_500,
    );
    if (!info.ok) {
        return {
            installed: true,
            accessible: false,
            detail: "Docker daemon not reachable with current permissions",
        };
    }

    return {
        installed: true,
        accessible: true,
        detail: `Docker daemon reachable (Server ${info.stdout})`,
    };
}

async function hasSshBinary(): Promise<boolean> {
    const result = await execCommand(["ssh", "-V"], 2_500);
    return result.ok || /OpenSSH/i.test(result.stderr);
}

export async function runPreflight(
    config: TunnelConfig,
): Promise<PreflightResult> {
    const issues: PreflightIssue[] = [];

    const hasSsh = await hasSshBinary();
    if (!hasSsh) {
        issues.push({
            level: "error",
            message: "ssh binary not found. Install OpenSSH client first.",
        });
    }

    if (config.mode === "L" && config.localPort) {
        const localPort = await checkLocalPort(
            config.localPort,
            config.bindAddress,
        );
        if (!localPort.available) {
            issues.push({
                level: "error",
                message: `Local port ${config.bindAddress}:${config.localPort} is already in use (${localPort.error ?? "busy"}).`,
            });
        }
    }

    if (config.mode !== "D" && !config.remotePort) {
        issues.push({
            level: "error",
            message: "Remote port is required for -L and -R tunnels.",
        });
    }

    const docker = await checkDockerStatus();
    if (config.dockerBridge?.enabled) {
        if (!docker.installed) {
            issues.push({
                level: "error",
                message:
                    "Docker bridge was requested but Docker is not installed.",
            });
        } else if (!docker.accessible) {
            issues.push({
                level: "error",
                message:
                    "Docker bridge was requested but Docker daemon access is unavailable.",
            });
        }
    }

    return { issues, docker };
}
