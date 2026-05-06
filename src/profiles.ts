import path from "node:path";
import type { TunnelConfig, TunnelProfile } from "./types.ts";
import {
    ensureConfigDir,
    makeId,
    readJsonFile,
    writeJsonFile,
} from "./utils.ts";

interface ProfilesFile {
    profiles: TunnelProfile[];
}

const EMPTY_PROFILES: ProfilesFile = { profiles: [] };

async function filePath(): Promise<string> {
    const dir = await ensureConfigDir();
    return path.join(dir, "profiles.json");
}

export async function loadProfiles(): Promise<TunnelProfile[]> {
    const fp = await filePath();
    const data = await readJsonFile<ProfilesFile>(fp, EMPTY_PROFILES);
    return data.profiles;
}

export async function saveProfile(
    name: string,
    config: TunnelConfig,
): Promise<TunnelProfile> {
    const fp = await filePath();
    const data = await readJsonFile<ProfilesFile>(fp, EMPTY_PROFILES);

    const profile: TunnelProfile = {
        id: makeId("profile"),
        name,
        updatedAt: new Date().toISOString(),
        config: {
            mode: config.mode,
            target: config.target,
            bindAddress: config.bindAddress,
            localPort: config.localPort,
            remoteHost: config.remoteHost,
            remotePort: config.remotePort,
            dynamicPort: config.dynamicPort,
            sshExtraArgs: config.sshExtraArgs,
            autoReconnect: config.autoReconnect,
            dockerBridge: config.dockerBridge,
        },
    };

    data.profiles = [
        profile,
        ...data.profiles.filter(
            (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
        ),
    ];
    await writeJsonFile(fp, data);
    return profile;
}

export function profileToTunnelConfig(profile: TunnelProfile): TunnelConfig {
    return {
        id: makeId("session"),
        name: profile.name,
        ...profile.config,
    };
}
