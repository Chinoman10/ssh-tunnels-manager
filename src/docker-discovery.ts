import {
    execCommand,
    execRemoteDockerCommand,
    type ExecResult,
} from "./utils.ts";

export interface DockerNetworkSuggestion {
    networks: string[];
    explanation: string;
    upstreamTarget?: string;
    upstreamSource?: string;
}

interface ContainerProbe {
    name: string;
    image: string;
    ports: string;
    labels: string;
    networks: string[];
}

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function parseContainerLine(line: string): ContainerProbe | null {
    const parts = line.split("||");
    if (parts.length < 5) return null;
    return {
        name: parts[0]!.trim(),
        image: parts[1]!.trim(),
        ports: parts[2]!.trim(),
        labels: parts[3]!.trim(),
        networks: parts[4]!
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
    };
}

function scoreContainer(
    container: ContainerProbe,
    tokens: string[],
    remotePort: number,
): number {
    let score = 0;
    const haystack =
        `${container.name} ${container.image} ${container.labels}`.toLowerCase();

    for (const token of tokens) {
        if (haystack.includes(token)) score += 5;
    }

    if (remotePort > 0) {
        const portRegex = new RegExp(`(^|[^0-9])${remotePort}($|[^0-9])`);
        if (portRegex.test(container.ports)) score += 4;
    }

    if (container.networks.length === 1) score += 1;

    return score;
}

function extractComposeService(labels: string): string | null {
    // Look for Docker Compose service label
    const match = labels.match(/com\.docker\.compose\.service=([^,]+)/);
    if (match && match[1]) {
        return match[1].trim();
    }
    return null;
}

function extractComposeProject(labels: string): string | null {
    const match = labels.match(/com\.docker\.compose\.project=([^,]+)/);
    if (match && match[1]) {
        return match[1].trim();
    }
    return null;
}

function findUpstreamCandidate(
    containers: ContainerProbe[],
    scoredContainers: { container: ContainerProbe; score: number }[],
    remotePort: number,
): { upstreamTarget: string; source: string } | null {
    // Prefer the highest-scored container with compose labels
    for (const { container } of scoredContainers) {
        const service = extractComposeService(container.labels);
        if (service) {
            return {
                upstreamTarget: `${service}:${remotePort}`,
                source: `com.docker.compose.service=${service}`,
            };
        }
    }

    // Fallback: any container with compose service label
    for (const container of containers) {
        const service = extractComposeService(container.labels);
        if (service) {
            return {
                upstreamTarget: `${service}:${remotePort}`,
                source: `com.docker.compose.service=${service} (unscored)`,
            };
        }
    }

    // Last resort: container name from highest scored
    if (scoredContainers.length > 0) {
        const name = scoredContainers[0]!.container.name;
        return {
            upstreamTarget: `${name}:${remotePort}`,
            source: `container name (${name})`,
        };
    }

    return null;
}

export async function detectLikelyDockerNetworks(args: {
    target?: string;
    presetName?: string;
    presetId?: string;
    remotePort: number;
}): Promise<DockerNetworkSuggestion> {
    const dockerFormat =
        "{{.Names}}||{{.Image}}||{{.Ports}}||{{.Labels}}||{{.Networks}}";

    // If we have an SSH target, run docker ps on the remote host
    let dockerResult: ExecResult & { usedSudo?: boolean };
    let usedSudo = false;
    if (args.target) {
        const remote = await execRemoteDockerCommand(args.target, [
            "ps",
            "--format",
            dockerFormat,
        ]);
        dockerResult = remote;
        usedSudo = remote.usedSudo;
    } else {
        // Fallback: run locally (e.g., when no target is known yet)
        dockerResult = await execCommand(
            ["docker", "ps", "--format", dockerFormat],
            4_000,
        );
    }

    const sudoTag = usedSudo ? " [sudo]" : "";
    const location = args.target
        ? `remote host (${args.target})${sudoTag}`
        : "local machine";

    if (!dockerResult.ok || !dockerResult.stdout) {
        return {
            networks: [],
            explanation: `No running Docker containers detected on ${location} or daemon inaccessible.`,
        };
    }

    const tokens = [
        args.presetName ?? "",
        args.presetId ?? "",
        `${args.remotePort}`,
    ]
        .flatMap((value) => tokenize(value))
        .filter((value) => value !== "port" && value !== "default");

    const containers = dockerResult.stdout
        .split(/\r?\n/)
        .map((line) => parseContainerLine(line))
        .filter((entry): entry is ContainerProbe => entry !== null);

    if (containers.length === 0) {
        return {
            networks: [],
            explanation: `Docker is running on ${location}, but no containers were found.`,
        };
    }

    const networkScores = new Map<string, number>();
    const scoredContainers: { container: ContainerProbe; score: number }[] = [];

    for (const container of containers) {
        const score = scoreContainer(container, tokens, args.remotePort);
        if (score > 0) {
            scoredContainers.push({ container, score });
        }

        for (const network of container.networks) {
            networkScores.set(
                network,
                (networkScores.get(network) ?? 0) + score,
            );
        }
    }

    scoredContainers.sort((a, b) => b.score - a.score);

    const ranked = [...networkScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([network]) => network);

    const upstream = findUpstreamCandidate(
        containers,
        scoredContainers,
        args.remotePort,
    );

    if (ranked.length === 0) {
        const fallback = new Set<string>();
        for (const container of containers) {
            if (
                args.remotePort > 0 &&
                new RegExp(`(^|[^0-9])${args.remotePort}($|[^0-9])`).test(
                    container.ports,
                )
            ) {
                container.networks.forEach((network) => fallback.add(network));
            }
        }

        return {
            networks: [...fallback],
            explanation:
                fallback.size > 0
                    ? `Matched containers on ${location} exposing port ${args.remotePort}.`
                    : `No strong match from name/image/labels on ${location}; no default selected.`,
            upstreamTarget: upstream?.upstreamTarget,
            upstreamSource: upstream?.source,
        };
    }

    return {
        networks: ranked.slice(0, 3),
        explanation: `Ranked likely networks on ${location} using service hints and port ${args.remotePort}.`,
        upstreamTarget: upstream?.upstreamTarget,
        upstreamSource: upstream?.source,
    };
}
