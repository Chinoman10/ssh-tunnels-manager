import {
    BoxRenderable,
    createCliRenderer,
    InputRenderable,
    InputRenderableEvents,
    SelectRenderable,
    SelectRenderableEvents,
    TextRenderable,
    TextAttributes,
} from "@opentui/core";
import { $ } from "bun";
import { detectLikelyDockerNetworks } from "./docker-discovery.ts";
import { loadServicePresets } from "./presets.ts";
import {
    loadProfiles,
    profileToTunnelConfig,
    saveProfile,
} from "./profiles.ts";
import { checkDockerStatus, runPreflight } from "./preflight.ts";
import { detectReverseProxyDomains } from "./reverse-proxy.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { loadSshAliases, sshEffectiveConfig } from "./ssh-config.ts";
import { checkLocalPort, suggestLocalPort } from "./ports.ts";
import { TunnelManager, previewCommand } from "./tunnel-manager.ts";
import type {
    CliFlags,
    DockerBridgeConfig,
    ProbePermission,
    ServicePreset,
    TunnelConfig,
    TunnelMode,
    TunnelTarget,
} from "./types.ts";
import {
    coercePort,
    execCommand,
    makeId,
    splitShellArgs,
    startSpinner,
    type SpinnerHandle,
} from "./utils.ts";

interface Choice<T = string> {
    name: string;
    description: string;
    value: T;
}

const BACK = "__back__";

export async function runTui(flags: CliFlags): Promise<void> {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        autoFocus: true,
    });

    const manager = new TunnelManager();

    const root = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexDirection: "column",
        padding: 1,
        gap: 1,
        backgroundColor: "#10151a",
    });

    const title = new TextRenderable(renderer, {
        height: 1,
        content: "SSH Tunnels Manager",
        fg: "#7ad7ff",
        attributes: TextAttributes.BOLD,
    });

    const subtitle = new TextRenderable(renderer, {
        height: 2,
        content: "Arrow keys to navigate, Enter to confirm.",
        fg: "#9fb4c0",
    });

    const status = new TextRenderable(renderer, {
        height: 3,
        content: "Ready.",
        fg: "#b7c6d0",
        wrapMode: "word",
    });

    const select = new SelectRenderable(renderer, {
        height: 16,
        showDescription: true,
        wrapSelection: true,
        showScrollIndicator: true,
        backgroundColor: "#182028",
        focusedBackgroundColor: "#1e2731",
        selectedBackgroundColor: "#2b4458",
        selectedTextColor: "#d8f4ff",
        selectedDescriptionColor: "#b9ebff",
        textColor: "#d4dde3",
        descriptionColor: "#9aadb9",
        options: [],
    });

    const input = new InputRenderable(renderer, {
        width: "100%",
        placeholder: "",
    });
    input.visible = false;

    const footer = new TextRenderable(renderer, {
        height: 2,
        content: "ESC to cancel prompt. Ctrl+C exits safely.",
        fg: "#8094a1",
        wrapMode: "word",
    });

    root.add(title);
    root.add(subtitle);
    root.add(status);
    root.add(select);
    root.add(input);
    root.add(footer);
    renderer.root.add(root);

    let uiActive = true;
    let promptResolver: ((value: string) => void) | null = null;
    let promptRejecter: (() => void) | null = null;
    let inputMode = false;
    let isShuttingDown = false;
    let lastStatus = "Ready.";
    let settings: { probePermission: ProbePermission } = {
        probePermission: "yes",
    };

    const selectionMap = new Map<string, string>();

    const safeSet = (renderable: TextRenderable, value: string) => {
        if (!uiActive || renderer.isDestroyed) return;
        renderable.content = value;
    };

    const updateStatus = (text: string) => {
        lastStatus = text;
        safeSet(status, text);
    };

    const rejectPrompt = () => {
        if (!promptRejecter) return;
        const reject = promptRejecter;
        promptResolver = null;
        promptRejecter = null;
        reject();
    };

    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        uiActive = false;

        updateStatus("⣾ Shutting down and cleaning up...");

        rejectPrompt();

        manager.off("state", onSessionState);
        manager.off("log", onSessionLog);
        renderer.keyInput.off("keypress", onKeyPress);

        await manager.stopAll();
        await saveSettings(settings);

        updateStatus("Goodbye.");

        if (!renderer.isDestroyed) {
            renderer.destroy();
        }
    };

    select.on(
        SelectRenderableEvents.ITEM_SELECTED,
        (_index: number, option: { value?: string }) => {
            const value = String(option?.value ?? "");
            if (!promptResolver || inputMode) return;
            const resolve = promptResolver;
            promptResolver = null;
            promptRejecter = null;
            resolve(value);
        },
    );

    input.on(InputRenderableEvents.ENTER, (value: string) => {
        if (!promptResolver || !inputMode) return;
        const resolve = promptResolver;
        promptResolver = null;
        promptRejecter = null;
        resolve(String(value ?? "").trim());
    });

    const onKeyPress = (key: { name: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === "c") {
            void shutdown();
            return;
        }

        if (key.name === "escape" && promptRejecter) {
            const reject = promptRejecter;
            promptResolver = null;
            promptRejecter = null;
            reject();
        }
    };
    renderer.keyInput.on("keypress", onKeyPress);

    const onSessionState = (session: { name: string; state: string }) => {
        safeSet(status, `Session ${session.name}: ${session.state}`);
    };
    manager.on("state", onSessionState);

    const onSessionLog = (_id: string, line: string) => {
        safeSet(status, line.slice(0, 400));
    };
    manager.on("log", onSessionLog);

    // ── Focus helpers: re-assert focus after a render tick ──
    const refocusSelect = async () => {
        await Bun.sleep(100);
        if (!uiActive || renderer.isDestroyed || inputMode) return;
        renderer.focusRenderable(select);
    };

    const refocusInput = async () => {
        await Bun.sleep(100);
        if (!uiActive || renderer.isDestroyed || !inputMode) return;
        renderer.focusRenderable(input);
    };

    // ── Loading spinner wrapper for async operations ──
    const withSpinner = async <T>(
        message: string,
        fn: (spinner: SpinnerHandle) => Promise<T>,
    ): Promise<T> => {
        const previousStatus = lastStatus;
        const spinner = startSpinner(updateStatus, message);
        try {
            const result = await fn(spinner);
            return result;
        } finally {
            spinner.stop(previousStatus);
        }
    };

    const selectPrompt = async <T extends string>(
        heading: string,
        lines: string[],
        choices: Choice<T>[],
        options?: { defaultValue?: T; defaultIndex?: number },
    ): Promise<T | null> => {
        safeSet(title, heading);
        safeSet(subtitle, lines.join("\n"));

        inputMode = false;
        input.visible = false;
        select.visible = true;

        selectionMap.clear();
        select.options = choices.map((choice, idx) => {
            const key = `opt-${idx}-${choice.value}`;
            selectionMap.set(key, String(choice.value));
            return {
                name: choice.name,
                description: choice.description,
                value: key,
            };
        });

        const selectedIndexByValue =
            options?.defaultValue !== undefined
                ? choices.findIndex(
                      (choice) => choice.value === options.defaultValue,
                  )
                : -1;
        const fallbackIndex = options?.defaultIndex ?? 0;
        const nextSelectedIndex =
            selectedIndexByValue >= 0 ? selectedIndexByValue : fallbackIndex;
        if (nextSelectedIndex >= 0 && nextSelectedIndex < choices.length) {
            select.selectedIndex = nextSelectedIndex;
        }

        renderer.focusRenderable(select);
        void refocusSelect();

        return new Promise<T | null>((resolve) => {
            promptResolver = (selectedKey) => {
                const value = selectionMap.get(selectedKey);
                resolve((value as T | undefined) ?? null);
            };
            promptRejecter = () => resolve(null);
        });
    };

    const inputPrompt = async (
        heading: string,
        lines: string[],
        placeholder: string,
        initialValue = "",
    ): Promise<string | null> => {
        safeSet(title, heading);
        safeSet(subtitle, lines.join("\n"));
        inputMode = true;

        select.visible = false;
        input.visible = true;
        input.placeholder = placeholder;
        input.value = initialValue;
        renderer.focusRenderable(input);
        void refocusInput();

        return new Promise<string | null>((resolve) => {
            promptResolver = (value) => resolve(value);
            promptRejecter = () => resolve(null);
        });
    };

    settings = await loadSettings();
    const presetsDoc = await loadServicePresets();
    const presets = presetsDoc.entries;
    const sshAliases = await loadSshAliases();

    safeSet(
        status,
        `Loaded ${sshAliases.length} SSH aliases, ${presets.length} service presets.`,
    );

    let running = true;

    process.on("SIGINT", () => {
        void shutdown();
    });

    while (running && !isShuttingDown) {
        const action = await selectPrompt(
            "SSH Tunnels Manager",
            [
                "Create and manage SSH tunnels with presets, preflight checks, and profiles.",
                "Select an action:",
            ],
            [
                {
                    name: "Create Tunnel",
                    description: "Start wizard for a new SSH tunnel",
                    value: "create",
                },
                {
                    name: "Sessions Dashboard",
                    description: "Inspect or stop active sessions",
                    value: "sessions",
                },
                {
                    name: "Profiles",
                    description: "Run a saved profile",
                    value: "profiles",
                },
                {
                    name: "Diagnostics",
                    description: "Run local environment checks",
                    value: "diag",
                },
                {
                    name: "Quit",
                    description: "Exit the application",
                    value: "quit",
                },
            ],
        );

        if (action === null || action === "quit") {
            running = false;
            continue;
        }

        if (action === "create") {
            await runCreateTunnelWizard({
                flags,
                sshAliases,
                presets,
                manager,
                selectPrompt,
                inputPrompt,
                settings,
                updateStatus,
                withSpinner,
            });
        } else if (action === "sessions") {
            await runSessionsDashboard({ selectPrompt, manager, status });
        } else if (action === "profiles") {
            await runProfilesMenu({
                selectPrompt,
                manager,
                status,
                updateStatus,
                withSpinner,
            });
        } else if (action === "diag") {
            await runDiagnostics({ selectPrompt, status });
        }
    }

    await shutdown();
}

// ── Diagnostics ──

async function runDiagnostics(args: {
    selectPrompt: <T extends string>(
        h: string,
        l: string[],
        c: Choice<T>[],
    ) => Promise<T | null>;
    status: TextRenderable;
}): Promise<void> {
    const docker = await checkDockerStatus();
    const ssh = await execCommand(["ssh", "-V"], 2_500);
    const lines = [
        `SSH: ${ssh.ok || ssh.stderr.includes("OpenSSH") ? "OK" : "Missing"}`,
        `Docker installed: ${docker.installed ? "yes" : "no"}`,
        `Docker accessible: ${docker.accessible ? "yes" : "no"}`,
        docker.detail,
    ];

    args.status.content = lines.join(" | ");

    await args.selectPrompt("Diagnostics", lines, [
        {
            name: "Back",
            description: "Return to main menu",
            value: BACK,
        },
    ]);
}

// ── Sessions Dashboard ──

async function runSessionsDashboard(args: {
    selectPrompt: <T extends string>(
        h: string,
        l: string[],
        c: Choice<T>[],
    ) => Promise<T | null>;
    manager: TunnelManager;
    status: TextRenderable;
}): Promise<void> {
    while (true) {
        const sessions = args.manager.list();
        const choices: Choice<string>[] = sessions.map((session) => ({
            name: `${session.name} [${session.state}]`,
            description: `${session.localUrl}  pid=${session.pid ?? "-"} restarts=${session.restartCount}`,
            value: session.id,
        }));
        choices.push({
            name: "Back",
            description: "Return to main menu",
            value: BACK,
        });

        const selected = await args.selectPrompt(
            "Sessions Dashboard",
            [
                sessions.length === 0
                    ? "No active sessions."
                    : `${sessions.length} active session(s).`,
                "Choose a session to inspect or stop.",
            ],
            choices,
        );

        if (!selected || selected === BACK) return;

        const target = sessions.find((session) => session.id === selected);
        if (!target) continue;

        const action = await args.selectPrompt(
            `Session: ${target.name}`,
            [
                `URL: ${target.localUrl}`,
                `Bind: ${target.localBind}`,
                target.commandPreview,
                target.lastError
                    ? `last error: ${target.lastError}`
                    : "no errors reported",
            ],
            [
                {
                    name: "Stop Session",
                    description: "Terminate the SSH process",
                    value: "stop",
                },
                {
                    name: "View Recent Logs",
                    description: "Show last captured output lines",
                    value: "logs",
                },
                {
                    name: "Back",
                    description: "Return to dashboard list",
                    value: BACK,
                },
            ],
        );

        if (action === "stop") {
            await args.manager.stop(target.id);
            args.status.content = `Stopped session ${target.name}.`;
        } else if (action === "logs") {
            await viewSessionLogs(
                args.selectPrompt,
                args.manager,
                target.id,
                target.name,
            );
        }
    }
}

// ── Paginated log viewer ──
const LOG_PAGE_SIZE = 8;

async function viewSessionLogs(
    selectPrompt: <T extends string>(
        h: string,
        l: string[],
        c: Choice<T>[],
        o?: { defaultValue?: T; defaultIndex?: number },
    ) => Promise<T | null>,
    manager: TunnelManager,
    sessionId: string,
    sessionName: string,
): Promise<void> {
    let page = 0;
    let showDiagnostics = false;
    let diagLines: string[] = [];

    while (true) {
        const rawLogs = manager.getLogs(sessionId);
        const structured = manager.getStructuredLogs(sessionId);

        // Build display lines: structured logs first, then raw logs
        const displayLines: string[] = [];

        // Structured lifecycle logs
        if (structured.length > 0) {
            displayLines.push("── Lifecycle ──");
            for (const entry of structured) {
                const ts = entry.timestamp.slice(11, 19); // HH:MM:SS
                displayLines.push(`[${ts}] [${entry.level}] ${entry.message}`);
            }
        }

        // Raw tunnel output
        if (rawLogs.length > 0) {
            displayLines.push("── Tunnel Output ──");
            for (const line of rawLogs) {
                displayLines.push(`  ${line.slice(0, 250)}`);
            }
        }

        // Diagnostic output (if fetched)
        if (showDiagnostics && diagLines.length > 0) {
            displayLines.push("── Diagnostics ──");
            for (const line of diagLines) {
                displayLines.push(`  ${line.slice(0, 250)}`);
            }
        }

        const total = displayLines.length;
        const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
        if (page >= totalPages) page = totalPages - 1;

        const start = page * LOG_PAGE_SIZE;
        const pageLines = displayLines.slice(start, start + LOG_PAGE_SIZE);

        const header =
            total === 0
                ? ["No logs captured yet for this tunnel."]
                : [
                      `Logs: ${sessionName}  (page ${page + 1}/${totalPages}, ${total} lines total)`,
                      "─".repeat(62),
                      ...pageLines,
                  ];

        const choices: Choice<string>[] = [];
        if (page > 0) {
            choices.push({
                name: "← Previous Page",
                description: `Page ${page} of ${totalPages}`,
                value: "prev",
            });
        }
        if (page < totalPages - 1) {
            choices.push({
                name: "Next Page →",
                description: `Page ${page + 2} of ${totalPages}`,
                value: "next",
            });
        }
        choices.push({
            name: showDiagnostics
                ? "Hide Diagnostics"
                : "Run Remote Diagnostics",
            description: "Fetch docker logs and curl from remote",
            value: "diag",
        });
        choices.push({
            name: "Back",
            description: "Return to session",
            value: BACK,
        });

        const action = await selectPrompt(
            `Logs: ${sessionName}`,
            header,
            choices,
            { defaultIndex: choices.length - 1 },
        );

        if (action === BACK || action === null) return;
        if (action === "prev") page -= 1;
        if (action === "next") page += 1;
        if (action === "diag") {
            if (!showDiagnostics) {
                diagLines = await fetchRemoteDiagnostics(manager, sessionId);
            }
            showDiagnostics = !showDiagnostics;
        }
    }
}

async function fetchRemoteDiagnostics(
    manager: TunnelManager,
    sessionId: string,
): Promise<string[]> {
    const lines: string[] = [];
    const sessions = manager.list();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return ["Session not found."];

    // Extract target from command preview (e.g., ssh -N -L ... ssdnodes2)
    const preview = session.commandPreview;
    const sshTarget = preview.split(" ").pop() ?? "unknown";

    // 1. Check local curl
    lines.push(`--- local curl ${session.localUrl} ---`);
    try {
        const localCurl =
            await $`curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 ${session.localUrl}`
                .nothrow()
                .quiet();
        lines.push(
            `HTTP ${localCurl.stdout.toString().trim() || localCurl.exitCode}`,
        );
    } catch {
        lines.push("curl failed");
    }

    // 2. Remote docker ps for bridge container
    lines.push(`--- remote docker ps (bridge) ---`);
    try {
        const ps =
            await $`ssh -o BatchMode=yes -o ConnectTimeout=5 ${sshTarget} sudo docker ps --filter name=stm-caddy --format '{{.Names}} {{.Status}} {{.Ports}}'`
                .nothrow()
                .quiet();
        const out = ps.stdout.toString().trim();
        lines.push(out || "no bridge container found");
    } catch {
        lines.push("docker ps failed");
    }

    // 3. Remote docker logs for bridge container
    lines.push(`--- remote bridge container logs ---`);
    try {
        const logResult =
            await $`ssh -o BatchMode=yes -o ConnectTimeout=5 ${sshTarget} sudo docker logs --tail 50 stm-caddy 2>&1`
                .nothrow()
                .quiet();
        const logOut =
            logResult.stdout.toString().trim() ||
            logResult.stderr.toString().trim();
        for (const line of logOut.split("\n").slice(-20)) {
            lines.push(`  ${line.slice(0, 250)}`);
        }
    } catch {
        lines.push("docker logs failed");
    }

    return lines;
}

// ── Profiles Menu ──

async function runProfilesMenu(args: {
    selectPrompt: <T extends string>(
        h: string,
        l: string[],
        c: Choice<T>[],
    ) => Promise<T | null>;
    manager: TunnelManager;
    status: TextRenderable;
    updateStatus: (text: string) => void;
    withSpinner: <T>(
        msg: string,
        fn: (s: SpinnerHandle) => Promise<T>,
    ) => Promise<T>;
}): Promise<void> {
    const profiles = await loadProfiles();
    if (profiles.length === 0) {
        await args.selectPrompt(
            "Profiles",
            ["No saved profiles found."],
            [{ name: "Back", description: "Return", value: BACK }],
        );
        return;
    }

    const selected = await args.selectPrompt(
        "Profiles",
        ["Run a saved profile as a managed tunnel session."],
        [
            ...profiles.map((profile) => ({
                name: profile.name,
                description: `Updated ${new Date(profile.updatedAt).toLocaleString()}`,
                value: profile.id,
            })),
            { name: "Back", description: "Return to main menu", value: BACK },
        ],
    );

    if (!selected || selected === BACK) return;
    const profile = profiles.find((entry) => entry.id === selected);
    if (!profile) return;

    const config = profileToTunnelConfig(profile);

    // Run preflight before launching
    const preflight = await runPreflight(config);
    const fatal = preflight.issues.filter((i) => i.level === "error");
    if (fatal.length > 0) {
        await args.selectPrompt(
            "Preflight Failed",
            [
                fatal.map((i) => i.message).join(" | "),
                "Try stopping other tunnels or picking a different port.",
            ],
            [{ name: "Back", description: "Return", value: BACK }],
        );
        return;
    }

    const snapshot = await args.withSpinner(
        `Starting profile "${profile.name}"...`,
        async (spinner) => {
            spinner.update(
                `Launching tunnel and Docker bridge for ${profile.name}...`,
            );
            return args.manager.start(config);
        },
    );
    args.status.content =
        snapshot.state === "failed"
            ? `Failed profile ${profile.name}: ${snapshot.lastError ?? "see logs"}`
            : `Started profile ${profile.name}.`;
}

// ── Create Tunnel Wizard ──

async function runCreateTunnelWizard(args: {
    flags: CliFlags;
    sshAliases: Awaited<ReturnType<typeof loadSshAliases>>;
    presets: ServicePreset[];
    manager: TunnelManager;
    settings: { probePermission: ProbePermission };
    selectPrompt: <T extends string>(
        h: string,
        l: string[],
        c: Choice<T>[],
        o?: { defaultValue?: T },
    ) => Promise<T | null>;
    inputPrompt: (
        h: string,
        l: string[],
        p: string,
        v?: string,
    ) => Promise<string | null>;
    updateStatus: (text: string) => void;
    withSpinner: <T>(
        msg: string,
        fn: (s: SpinnerHandle) => Promise<T>,
    ) => Promise<T>;
}): Promise<void> {
    let target: TunnelTarget | null = null;
    let guidedTargetArgs: string[] = [];
    let selectedPreset: ServicePreset | null = null;

    const aliasChoices: Choice<string>[] = args.sshAliases
        .filter((entry) => !entry.isWildcard)
        .map((entry) => ({
            name: entry.alias,
            description: `from ${entry.sourceFile}`,
            value: entry.alias,
        }));

    aliasChoices.push(
        { name: "Other", description: "Enter host manually", value: "other" },
        { name: "Back", description: "Return to main menu", value: BACK },
    );

    const chosenAlias = await args.selectPrompt(
        "Target Host",
        ["Select an SSH alias from ~/.ssh/config or choose Other."],
        aliasChoices,
    );

    if (!chosenAlias || chosenAlias === BACK) return;

    if (chosenAlias === "other") {
        const manualMode = await args.selectPrompt(
            "Manual Target",
            ["Choose how you want to define the SSH destination."],
            [
                {
                    name: "Full destination",
                    description: "Enter alias or user@host manually",
                    value: "full",
                },
                {
                    name: "Step-by-step",
                    description: "Provide host/user/port in separate prompts",
                    value: "guided",
                },
                { name: "Back", description: "Cancel wizard", value: BACK },
            ],
        );

        if (!manualMode || manualMode === BACK) return;

        if (manualMode === "full") {
            const destination = await args.inputPrompt(
                "Manual Target",
                [
                    "Enter alias, user@host, or full destination syntax.",
                    "Examples: ssdnodes2 or root@example.com",
                ],
                "user@host",
            );
            if (!destination) return;
            target = { destination };
        } else {
            const host = await args.inputPrompt(
                "Remote Host",
                ["Enter hostname or IP address."],
                "example.com",
            );
            if (!host) return;

            const user = await args.inputPrompt(
                "Remote User",
                ["Optional. Leave blank to use SSH defaults."],
                "root",
            );

            const port = await args.inputPrompt(
                "SSH Port",
                ["Optional SSH port. Leave blank for default 22."],
                "22",
            );

            const portNum = coercePort(port ?? undefined);
            if (port && !portNum) return;

            const destination =
                user && user.trim().length > 0 ? `${user}@${host}` : host;
            target = { destination };

            if (portNum && portNum !== 22) {
                guidedTargetArgs = ["-p", `${portNum}`];
            }
        }
    } else {
        target = { alias: chosenAlias, destination: chosenAlias };

        // ── Spinner: SSH effective config ──
        const effective = await args.withSpinner(
            `Reading SSH config for ${chosenAlias}...`,
            async () => sshEffectiveConfig(chosenAlias),
        );

        if (effective.length > 0) {
            await args.selectPrompt(
                `SSH Config: ${chosenAlias}`,
                [effective.join(" | ")],
                [
                    {
                        name: "Continue",
                        description: "Use this target",
                        value: "continue",
                    },
                ],
            );
        }
    }

    const mode = (await args.selectPrompt(
        "Tunnel Mode",
        [
            "Choose SSH forwarding mode.",
            "-L (recommended): open local port to reach remote service.",
            "-R: expose your local service to the remote host.",
            "-D: SOCKS proxy for flexible outbound access.",
        ],
        [
            {
                name: "Local Forward (-L)",
                description: "Local port -> remote host:port",
                value: "L",
            },
            {
                name: "Remote Forward (-R)",
                description: "Remote port -> local host:port",
                value: "R",
            },
            {
                name: "Dynamic SOCKS (-D)",
                description: "SOCKS proxy",
                value: "D",
            },
            { name: "Back", description: "Cancel wizard", value: BACK },
        ],
        { defaultValue: "L" },
    )) as TunnelMode | typeof BACK | null;

    if (!mode || mode === BACK) return;

    let remoteHost = "127.0.0.1";
    let remotePort = 0;

    if (mode !== "D") {
        const remoteKind = await args.selectPrompt(
            "Remote Target",
            ["Are you tunneling to remote localhost or reverse-proxy domain?"],
            [
                {
                    name: "Server localhost/127.0.0.1",
                    description: "Direct service port on remote host",
                    value: "local",
                },
                {
                    name: "Reverse proxy/domain",
                    description: "Tunnel to domain routed by proxy",
                    value: "domain",
                },
                { name: "Back", description: "Cancel wizard", value: BACK },
            ],
        );

        if (!remoteKind || remoteKind === BACK) return;

        if (remoteKind === "domain") {
            let probePermission =
                args.flags.probePermission ?? args.settings.probePermission;
            if (probePermission === "yes") {
                const probeChoice = await args.selectPrompt(
                    "Probe Permission",
                    ["Allow remote probe for Nginx/Caddy/Traefik domains?"],
                    [
                        {
                            name: "Yes",
                            description: "Allow this time",
                            value: "yes",
                        },
                        {
                            name: "Yes (always)",
                            description: "Persist and stop asking",
                            value: "always",
                        },
                        {
                            name: "No",
                            description: "Skip probe and type manually",
                            value: "no",
                        },
                    ],
                );
                if (!probeChoice) return;
                probePermission = probeChoice as ProbePermission;
                args.settings.probePermission = probePermission;
            }

            let domain = args.flags.reverseDomain;
            if (!domain && probePermission !== "no") {
                // ── Spinner: reverse proxy detection ──
                const detected = await args.withSpinner(
                    "Probing remote reverse-proxy configs...",
                    async (spinner) => {
                        spinner.update(
                            `SSHing to ${target!.alias ?? target!.destination} to scan proxy configs...`,
                        );
                        return detectReverseProxyDomains(target!);
                    },
                );

                if (detected.domains.length > 0) {
                    const selectedDomain = await args.selectPrompt(
                        "Detected Domains",
                        [
                            `Scanned: ${detected.checked.join(", ") || "common proxy paths"}`,
                            "Choose a detected domain or select custom.",
                        ],
                        [
                            ...detected.domains.slice(0, 30).map((entry) => ({
                                name: entry,
                                description: "Detected from proxy config",
                                value: entry,
                            })),
                            {
                                name: "Custom Domain",
                                description: "Type manually",
                                value: "custom",
                            },
                        ],
                    );

                    if (!selectedDomain) return;
                    if (selectedDomain === "custom") {
                        domain =
                            (await args.inputPrompt(
                                "Domain",
                                ["Enter reverse proxy domain:"],
                                "app.example.com",
                            )) ?? undefined;
                    } else {
                        domain = selectedDomain;
                    }
                }
            }

            if (!domain) {
                domain =
                    (await args.inputPrompt(
                        "Domain",
                        ["Enter reverse proxy domain:"],
                        "app.example.com",
                    )) ?? undefined;
            }
            if (!domain) return;
            remoteHost = domain;
        }

        const presetChoice = await args.selectPrompt(
            "Service Port",
            ["Choose common service/game ports or enter custom."],
            [
                ...args.presets.map((preset) => ({
                    name: preset.name,
                    description: `${preset.category} - ${preset.ports.map((p) => `${p.port}/${p.protocol}`).join(", ")}`,
                    value: preset.id,
                })),
                {
                    name: "Custom Port",
                    description: "Enter manually",
                    value: "custom",
                },
            ],
        );

        if (!presetChoice) return;

        if (presetChoice === "custom") {
            const remotePortRaw = await args.inputPrompt(
                "Remote Port",
                ["Enter remote port number."],
                "9443",
            );
            const parsed = coercePort(remotePortRaw ?? undefined);
            if (!parsed) return;
            remotePort = parsed;
        } else {
            const preset = args.presets.find(
                (entry) => entry.id === presetChoice,
            );
            if (!preset) return;
            selectedPreset = preset;

            const portOption = await args.selectPrompt(
                `Preset: ${preset.name}`,
                ["Choose a port/protocol combination."],
                preset.ports.map((entry, idx) => ({
                    name: `${entry.port}/${entry.protocol}`,
                    description: entry.note ?? "",
                    value: `${idx}`,
                })),
            );

            if (!portOption) return;
            const chosen = preset.ports[Number.parseInt(portOption, 10)];
            if (!chosen) return;
            remotePort = chosen.port;

            if (chosen.protocol === "udp") {
                await args.selectPrompt(
                    "UDP Warning",
                    [
                        "SSH tunnels are TCP only.",
                        "You selected a UDP port; this may not work for gameplay traffic.",
                        "Continue only if you know this service has a TCP endpoint.",
                    ],
                    [
                        {
                            name: "Continue",
                            description: "Proceed anyway",
                            value: "continue",
                        },
                    ],
                );
            }
        }
    }

    const defaultLocalPort = mode === "D" ? 1080 : remotePort || 9443;

    // ── Spinner: local port suggestion ──
    const suggested = await args.withSpinner(
        "Checking local port availability...",
        async () => suggestLocalPort(defaultLocalPort),
    );

    const localPortRaw = await args.inputPrompt(
        "Local Port",
        [
            `Enter port number, or press Enter for default (${suggested}).`,
            "Binding uses 127.0.0.1 by default.",
        ],
        `${suggested} (default)`,
        "",
    );
    if (localPortRaw === null) return;
    const localPort = coercePort(localPortRaw || `${suggested}`);
    if (!localPort) return;

    // ── Spinner: port check ──
    const portStatus = await args.withSpinner(
        `Verifying port ${localPort} is free...`,
        async () => checkLocalPort(localPort, "127.0.0.1"),
    );

    if (!portStatus.available) {
        const procInfo = await execCommand(
            ["lsof", "-nPi", `:${localPort}`],
            2_500,
        );
        await args.selectPrompt(
            "Port Busy",
            [
                `Port ${localPort} is in use (${portStatus.error ?? "busy"}).`,
                procInfo.ok
                    ? procInfo.stdout.replace(/\r?\n/g, " | ")
                    : "Process details unavailable on this platform.",
            ],
            [{ name: "Back", description: "Restart wizard", value: BACK }],
        );
        return;
    }

    const dockerMode = await args.selectPrompt(
        "Docker Bridge",
        [
            "Optional experimental mode: start an ephemeral Caddy sidecar on the remote host",
            "and attach it to remote Docker networks so the tunnel bridges into container networks.",
            "Useful when the target service is on a Docker network not exposed to the host.",
        ],
        [
            {
                name: "Disabled",
                description: "Regular SSH tunnel only",
                value: "off",
            },
            {
                name: "Enabled",
                description: "Opt-in remote Docker bridge sidecar",
                value: "on",
            },
        ],
    );
    if (!dockerMode) return;

    let dockerBridge: DockerBridgeConfig | undefined;
    if (dockerMode === "on") {
        const sshDest = target?.alias ?? target?.destination ?? "";

        // ── Spinner: remote Docker discovery ──
        const suggestion = await args.withSpinner(
            `Querying Docker containers on remote host (${sshDest})...`,
            async (spinner) => {
                spinner.update(`Running docker ps via SSH to ${sshDest}...`);
                return detectLikelyDockerNetworks({
                    target: sshDest,
                    presetName: selectedPreset?.name,
                    presetId: selectedPreset?.id,
                    remotePort,
                });
            },
        );

        const suggestedNetworks = suggestion.networks.join(",");
        const promptHint =
            suggestedNetworks.length > 0
                ? `${suggestedNetworks} (auto-detected on remote)`
                : "none detected on remote (optional)";

        const upstreamNote = suggestion.upstreamTarget
            ? `\nCaddy will proxy to ${suggestion.upstreamTarget} (${suggestion.upstreamSource ?? "auto-detected"}).`
            : "";

        const networksRaw = await args.inputPrompt(
            "Docker Networks",
            [
                suggestion.explanation + upstreamNote,
                "Comma-separated network names. Leave empty to skip network attachments.",
            ],
            promptHint,
            suggestedNetworks,
        );
        if (networksRaw === null) return;
        dockerBridge = {
            enabled: true,
            networks: networksRaw
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean),
            containerNamePrefix: "stm-caddy",
            upstreamTarget: suggestion.upstreamTarget,
        };
    }

    const sshExtraRaw = await args.inputPrompt(
        "Extra SSH Args",
        [
            "Optional extra SSH args (e.g. -o ServerAliveInterval=20). Leave empty if not needed.",
        ],
        "",
        "",
    );
    if (sshExtraRaw === null) return;
    const sshExtraArgs = [...guidedTargetArgs, ...splitShellArgs(sshExtraRaw)];

    const config: TunnelConfig = {
        id: makeId("session"),
        name: target.alias ?? target.destination,
        mode,
        target,
        bindAddress: "127.0.0.1",
        localPort,
        dynamicPort: localPort,
        remoteHost: mode === "D" ? undefined : remoteHost,
        remotePort: mode === "D" ? undefined : remotePort,
        sshExtraArgs,
        autoReconnect: true,
        dockerBridge,
    };

    // ── Spinner: preflight ──
    const preflight = args.flags.skipPreflight
        ? { issues: [], docker: await checkDockerStatus() }
        : await args.withSpinner("Running preflight checks...", async () =>
              runPreflight(config),
          );

    const summaryLines = [
        `Command: ${previewCommand(config)}`,
        `Preflight issues: ${preflight.issues.length}`,
        `Docker: ${preflight.docker.detail}`,
        dockerBridge?.enabled
            ? "Docker bridge sidecar will run on the remote host (experimental)."
            : "Docker bridge disabled.",
    ];

    const fatal = preflight.issues.filter((issue) => issue.level === "error");
    const summaryAction = await args.selectPrompt(
        "Review & Launch",
        summaryLines,
        [
            {
                name: "Start Tunnel",
                description: "Launch managed session",
                value: "start",
            },
            {
                name: "Dry Run",
                description: "Show final ssh command only",
                value: "dry",
            },
            {
                name: "Save Profile",
                description: "Store config for quick reuse",
                value: "save",
            },
            { name: "Back", description: "Cancel launch", value: BACK },
        ],
    );

    if (!summaryAction || summaryAction === BACK) return;

    if (summaryAction === "dry") {
        await args.selectPrompt(
            "Dry Run",
            [previewCommand(config)],
            [{ name: "Back", description: "Return", value: BACK }],
        );
        return;
    }

    if (summaryAction === "save") {
        const profileName = await args.inputPrompt(
            "Save Profile",
            ["Enter profile name."],
            config.name,
            config.name,
        );
        if (!profileName) return;
        await saveProfile(profileName, config);
        await args.selectPrompt(
            "Saved",
            [`Saved profile ${profileName}.`],
            [{ name: "Back", description: "Return", value: BACK }],
        );
        return;
    }

    if (fatal.length > 0) {
        await args.selectPrompt(
            "Preflight Failed",
            [fatal.map((issue) => issue.message).join(" | ")],
            [
                {
                    name: "Back",
                    description: "Fix issues and retry",
                    value: BACK,
                },
            ],
        );
        return;
    }

    args.updateStatus(`Starting tunnel: ${config.name}...`);
    const snapshot = await args.manager.start(config);
    if (snapshot.state === "failed") {
        args.updateStatus(`Failed tunnel: ${snapshot.lastError ?? "see logs"}`);
    }
}
