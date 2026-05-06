/**
 * Integration test: Local Docker Caddy sidecar
 *
 * Verifies:
 *  A. Caddy container can route host-based .localhost names to a host service
 *  B. Caddy container can reach a host service bound to 127.0.0.1
 *
 * Requires: Docker, curl
 * Skip if:   STM_INTEGRATION is not set
 *
 * Run:
 *   STM_INTEGRATION=1 bun test tests/integration/local-caddy.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

const RUN = Bun.env.STM_INTEGRATION === "1";
const itSkip = RUN ? test : test.skip;

// ── Helpers ──

function randomPort(): number {
    return 20000 + Math.floor(Math.random() * 30000);
}

function randomSuffix(): string {
    return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function sh(cmd: string): Promise<{ code: number; out: string; err: string }> {
    const r = await $`${{ raw: cmd }}`.nothrow().quiet();
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

async function dockerRm(...names: string[]): Promise<void> {
    for (const name of names) {
        await $`docker rm -f ${name}`.nothrow().quiet();
    }
}

// ── Tests ──

describe("Local Caddy Integration", () => {
    const suffix = randomSuffix();
    const echoPort = randomPort();
    const caddyPort = randomPort();
    const echoContainer = `stm-it-echo-${suffix}`;
    const caddyContainer = `stm-it-caddy-${suffix}`;
    const caddyfilePath = `/tmp/stm-it-caddyfile-${suffix}`;

    beforeAll(async () => {
        if (!RUN) return;
        // Clean up any leftovers
        await dockerRm(echoContainer, caddyContainer);

        // Start echo service: binds 127.0.0.1:{echoPort} → responds "stm-ok"
        const echoResult = await sh(
            `docker run -d --rm --name ${echoContainer} -p 127.0.0.1:${echoPort}:80 ` +
            `caddy:2-alpine caddy respond --listen :80 --body stm-ok`
        );
        if (echoResult.code !== 0) {
            throw new Error(`Echo container failed: ${echoResult.err}`);
        }
        // Wait for it to be ready
        await Bun.sleep(800);
    });

    afterAll(async () => {
        if (!RUN) return;
        await dockerRm(echoContainer, caddyContainer);
        await $`rm -f ${caddyfilePath}`.nothrow().quiet();
    });

    itSkip("A. Caddy routes Host header to upstream (bridge mode)", async () => {
        // Generate Caddyfile
        const caddyfile = `{
    admin off
    auto_https off
}

http://it-test.localhost {
    bind 0.0.0.0
    reverse_proxy host.docker.internal:${echoPort}
}
`;
        await Bun.write(caddyfilePath, caddyfile);

        // Start Caddy container in bridge mode
        const start = await sh(
            `docker run -d --rm --name ${caddyContainer} ` +
            `-p 127.0.0.1:${caddyPort}:80 ` +
            `--add-host=host.docker.internal:host-gateway ` +
            `-v ${caddyfilePath}:/etc/caddy/Caddyfile:ro ` +
            `caddy:2-alpine caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`
        );
        expect(start.code).toBe(0);
        await Bun.sleep(1000);

        // Fetch with Host header
        const curl = await sh(
            `curl -s -w '\\n%{http_code}' -H "Host: it-test.localhost" http://127.0.0.1:${caddyPort}/`
        );
        console.log("Bridge mode curl:", curl.out.slice(0, 200));
        expect(curl.out).toContain("stm-ok");
        expect(curl.out).toContain("200");
    });

    itSkip("B. Caddy container can reach host 127.0.0.1 service (host networking)", async () => {
        // Generate Caddyfile with 127.0.0.1 upstream (host networking)
        const caddyfile = `{
    admin off
    auto_https off
}

http://it-host.localhost {
    bind 0.0.0.0
    reverse_proxy 127.0.0.1:${echoPort}
}
`;
        await Bun.write(caddyfilePath, caddyfile);

        // Start Caddy with host networking
        const start = await sh(
            `docker run -d --rm --name ${caddyContainer} ` +
            `--network host ` +
            `-v ${caddyfilePath}:/etc/caddy/Caddyfile:ro ` +
            `caddy:2-alpine caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`
        );
        expect(start.code).toBe(0);
        await Bun.sleep(1000);

        // Host networking: Caddy listens directly on host port 80 (conflicts possible)
        // Instead, test by reaching the echo directly from inside the Caddy container
        const wget = await sh(
            `docker exec ${caddyContainer} wget -q -O - --timeout=3 http://127.0.0.1:${echoPort}/`
        );
        console.log("Host mode wget:", wget.out.slice(0, 200));
        expect(wget.out).toContain("stm-ok");
    });
});
