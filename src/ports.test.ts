import { describe, expect, test } from "bun:test";
import { formatLocalPortOccupiedMessage } from "./ports.ts";

describe("local port occupancy reporting", () => {
    test("includes PID, command, SSH tunnel classification, and action", () => {
        const message = formatLocalPortOccupiedMessage("127.0.0.1", 9000, {
            pid: 41355,
            command: "ssh -N -L 127.0.0.1:9000:127.0.0.1:9000 ssdnodes2",
            isSshTunnel: true,
            isLikelyManagedSession: false,
            raw: "ssh listener",
        });

        expect(message).toContain("Local port 127.0.0.1:9000 is already in use by PID 41355");
        expect(message).toContain("ssh -N -L 127.0.0.1:9000:127.0.0.1:9000 ssdnodes2");
        expect(message).toContain("It appears to be an SSH tunnel.");
        expect(message).toContain("Stop that process or choose another local port.");
    });
});
