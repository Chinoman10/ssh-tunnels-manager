export type TunnelMode = "L" | "R" | "D";

export type ProbePermission = "yes" | "always" | "no";

export interface SshHostEntry {
    alias: string;
    sourceFile: string;
    patterns: string[];
    isWildcard: boolean;
}

export interface ServicePortEntry {
    port: number;
    protocol: "tcp" | "udp";
    note?: string;
}

export interface ServicePreset {
    id: string;
    name: string;
    category: string;
    ports: ServicePortEntry[];
}

export interface ServicePresetDocument {
    version: string;
    generatedAt: string;
    entries: ServicePreset[];
}

export interface TunnelTarget {
    alias?: string;
    destination: string;
}

export interface TunnelConfig {
    id: string;
    name: string;
    mode: TunnelMode;
    target: TunnelTarget;
    bindAddress: string;
    localPort?: number;
    remoteHost?: string;
    remotePort?: number;
    dynamicPort?: number;
    sshExtraArgs: string[];
    autoReconnect: boolean;
    dockerBridge?: DockerBridgeConfig;
}

export interface DockerBridgeConfig {
    enabled: boolean;
    networks: string[];
    containerNamePrefix: string;
    upstreamTarget?: string;
    remoteBridgePort?: number;
    keepFailedBridgeContainer?: boolean;
}

export interface PreflightIssue {
    level: "info" | "warning" | "error";
    message: string;
}

export interface ReverseProxyDetection {
    found: boolean;
    domains: string[];
    hints: string[];
    checked: string[];
}

export interface TunnelProfile {
    id: string;
    name: string;
    updatedAt: string;
    config: Omit<TunnelConfig, "id" | "name">;
}

export interface CliFlags {
    diagnose?: boolean;
    nonInteractive: boolean;
    skipPreflight: boolean;
    dryRun: boolean;
    target?: string;
    mode?: TunnelMode;
    localPort?: number;
    remoteHost?: string;
    remotePort?: number;
    bindAddress?: string;
    autoReconnect?: boolean;
    profile?: string;
    reverseDomain?: string;
    sshExtraArgs: string[];
    dockerBridge: boolean;
    dockerNetworks: string[];
    probePermission?: ProbePermission;
    replaceExisting?: boolean;
    keepFailedBridgeContainer?: boolean;
}
