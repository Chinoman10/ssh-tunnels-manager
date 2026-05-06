/**
 * Integration test: remote-style Docker bridge behavior.
 *
 * Requires:
 *   STM_INTEGRATION=1 bun test tests/integration/docker-bridge.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

const RUN = Bun.env.STM_INTEGRATION === "1";
const itSkip = RUN ? test : test.skip;

function randomSuffix(): string {
    return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function randomPort(): number {
    return 41000 + Math.floor(Math.random() * 900);
}

async function sh(cmd: string): Promise<{ code: number; out: string; err: string }> {
    const r = await $`${{ raw: cmd }}`.nothrow().quiet();
    return {
        code: r.exitCode,
        out: r.stdout.toString().trim(),
        err: r.stderr.toString().trim(),
    };
}

describe("Docker bridge integration", () => {
    const suffix = randomSuffix();
    const network = `stm-it-net-${suffix}`;
    const service = `stm-it-http-${suffix}`;
    const bridge = `stm-it-bridge-${suffix}`;
    const bridgePort = randomPort();

    beforeAll(async () => {
        if (!RUN) return;
        await sh(`docker rm -f ${service} ${bridge}`);
        await sh(`docker network rm ${network}`);
        const net = await sh(`docker network create ${network}`);
        if (net.code !== 0) throw new Error(net.err);
        const svc = await sh(
            `docker run -d --rm --name ${service} --network ${network} caddy:2-alpine caddy respond --listen :80 --body stm-ok`,
        );
        if (svc.code !== 0) throw new Error(svc.err);
        await Bun.sleep(800);
    });

    afterAll(async () => {
        if (!RUN) return;
        await sh(`docker rm -f ${service} ${bridge}`);
        await sh(`docker network rm ${network}`);
    });

    itSkip("proxies an unpublished service through a loopback-published bridge", async () => {
        const start = await sh(
            `docker run -d --name ${bridge} -p 127.0.0.1:${bridgePort}:80 --network ${network} caddy:2-alpine caddy reverse-proxy --from :80 --to ${service}:80`,
        );
        expect(start.code).toBe(0);
        await Bun.sleep(1000);

        const ps = await sh(`docker ps --filter name=${bridge} --format "{{.Ports}}"`);
        expect(ps.out).toContain(`127.0.0.1:${bridgePort}->80/tcp`);
        expect(ps.out).not.toContain(`0.0.0.0:${bridgePort}`);

        const curl = await sh(
            `curl -s -o /tmp/stm-it-curl-${suffix} -w "%{http_code}" http://127.0.0.1:${bridgePort}/`,
        );
        expect(curl.code).toBe(0);
        expect(curl.out).toBe("200");
    });
});
