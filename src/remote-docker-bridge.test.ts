import { describe, expect, test } from "bun:test";
import {
    buildRemoteBridgeRunArgs,
    normalizeDockerBridgeRuntime,
    selectRemoteDockerRunnerFromResults,
    type RemoteBridgeRuntime,
} from "./remote-docker-bridge.ts";

describe("remote docker bridge helpers", () => {
    test("normalizes docker bridge without reusing the upstream port", () => {
        const runtime = normalizeDockerBridgeRuntime({
            id: "a",
            name: "ssdnodes2-portainer",
            mode: "L",
            target: { alias: "ssdnodes2", destination: "ssdnodes2" },
            bindAddress: "127.0.0.1",
            localPort: 9000,
            remoteHost: "127.0.0.1",
            remotePort: 9000,
            sshExtraArgs: [],
            autoReconnect: true,
            dockerBridge: {
                enabled: true,
                networks: ["portainer_default"],
                containerNamePrefix: "stm-caddy",
                upstreamTarget: "portainer:9000",
            },
        });

        expect(runtime.localPort).toBe(9000);
        expect(runtime.upstreamTarget).toBe("portainer:9000");
        expect(runtime.network).toBe("portainer_default");
    });

    test("builds loopback-only remote caddy publish args", () => {
        const runtime: RemoteBridgeRuntime = {
            sshTarget: "ssdnodes2",
            profileSlug: "ssdnodes2-portainer",
            network: "portainer_default",
            upstreamTarget: "portainer:9000",
            localBindAddress: "127.0.0.1",
            localPort: 9000,
            remoteDocker: { label: "sudo -n docker", argv: ["sudo", "-n", "docker"] },
            remoteBridgePort: 41000,
            bridgeContainerName: "stm-remote-caddy-ssdnodes2-portainer-abcd1234",
        };

        expect(buildRemoteBridgeRunArgs(runtime)).toEqual([
            "run",
            "-d",
            "--name",
            "stm-remote-caddy-ssdnodes2-portainer-abcd1234",
            "-p",
            "127.0.0.1:41000:80",
            "--network",
            "portainer_default",
            "caddy:2-alpine",
            "caddy",
            "reverse-proxy",
            "--from",
            ":80",
            "--to",
            "portainer:9000",
        ]);
    });

    test("selects sudo -n docker when plain docker fails and sudo works", () => {
        expect(
            selectRemoteDockerRunnerFromResults({ ok: false }, { ok: true }),
        ).toEqual({ label: "sudo -n docker", argv: ["sudo", "-n", "docker"] });
    });
});
