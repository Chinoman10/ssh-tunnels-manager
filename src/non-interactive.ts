import { loadProfiles, profileToTunnelConfig } from "./profiles.ts";
import { runPreflight } from "./preflight.ts";
import { TunnelManager, previewCommand } from "./tunnel-manager.ts";
import type { CliFlags, TunnelConfig } from "./types.ts";
import { makeId } from "./utils.ts";

function validateFlags(flags: CliFlags): string[] {
    const issues: string[] = [];
    if (!flags.profile && !flags.target) {
        issues.push("--target is required unless --profile is provided.");
    }
    if (!flags.profile && !flags.mode) {
        issues.push("--mode is required unless --profile is provided.");
    }
    if (
        !flags.profile &&
        flags.mode !== "D" &&
        !flags.remotePort &&
        !flags.reverseDomain
    ) {
        issues.push(
            "--remote-port is required for non-dynamic tunnels unless --reverse-domain is set.",
        );
    }
    if (!flags.profile && flags.mode === "D" && !flags.localPort) {
        issues.push("--local-port is required for dynamic tunnels.");
    }
    return issues;
}

export async function configFromFlags(flags: CliFlags): Promise<TunnelConfig> {
    if (flags.profile) {
        const profiles = await loadProfiles();
        const profile = profiles.find(
            (entry) =>
                entry.name.toLowerCase() === flags.profile?.toLowerCase(),
        );
        if (!profile)
            throw new Error(`Profile \"${flags.profile}\" not found.`);
        return {
            ...profileToTunnelConfig(profile),
            id: makeId("session"),
        };
    }

    return {
        id: makeId("session"),
        name: flags.target ?? "manual-target",
        mode: flags.mode ?? "L",
        target: {
            alias: flags.target,
            destination: flags.target ?? "",
        },
        bindAddress: flags.bindAddress ?? "127.0.0.1",
        localPort: flags.localPort,
        remoteHost: flags.reverseDomain ?? flags.remoteHost ?? "127.0.0.1",
        remotePort: flags.remotePort,
        dynamicPort: flags.localPort,
        sshExtraArgs: flags.sshExtraArgs,
        autoReconnect: flags.autoReconnect ?? true,
        dockerBridge: flags.dockerBridge
            ? {
                  enabled: true,
                  networks: flags.dockerNetworks,
                  containerNamePrefix: "stm-caddy",
              }
            : undefined,
    };
}

export async function runNonInteractive(flags: CliFlags): Promise<void> {
    const validation = validateFlags(flags);
    if (validation.length > 0) {
        for (const issue of validation) console.error(`- ${issue}`);
        process.exit(1);
    }

    const config = await configFromFlags(flags);

    if (!flags.skipPreflight) {
        const preflight = await runPreflight(config);
        const errors = preflight.issues.filter(
            (issue) => issue.level === "error",
        );
        if (errors.length > 0) {
            console.error("Preflight failed:");
            for (const issue of preflight.issues) {
                console.error(`- [${issue.level}] ${issue.message}`);
            }
            process.exit(1);
        }
    }

    const preview = previewCommand(config);
    if (flags.dryRun) {
        console.log(preview);
        return;
    }

    console.log(`Starting tunnel: ${preview}`);
    const manager = new TunnelManager();

    manager.on("log", (_id, line) => {
        console.log(line);
    });

    manager.on("state", async (snapshot) => {
        if (snapshot.state === "failed" || snapshot.state === "stopped") {
            await manager.stopAll();
            process.exit(snapshot.state === "failed" ? 1 : 0);
        }
    });

    const snapshot = await manager.start(config);
    if (snapshot.state === "failed") {
        await manager.stopAll();
        process.exit(1);
    }
    console.log(`Session ${config.id} running. Press Ctrl+C to stop.`);

    process.on("SIGINT", async () => {
        await manager.stopAll();
        process.exit(0);
    });

    await new Promise(() => {
        // Keep process alive while tunnel manager owns child processes.
    });
}
