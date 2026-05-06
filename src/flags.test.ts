import { describe, expect, test } from "bun:test";
import { parseFlags } from "./flags.ts";

describe("parseFlags", () => {
  test("parses primary non-interactive options", () => {
    const flags = parseFlags([
      "--non-interactive",
      "--target",
      "ssdnodes2",
      "--mode",
      "L",
      "--local-port",
      "19443",
      "--remote-port",
      "9443",
      "--ssh-extra",
      "-o ServerAliveInterval=20",
      "--docker-bridge",
      "--docker-network",
      "coolify",
    ]);

    expect(flags.nonInteractive).toBe(true);
    expect(flags.target).toBe("ssdnodes2");
    expect(flags.mode).toBe("L");
    expect(flags.localPort).toBe(19443);
    expect(flags.remotePort).toBe(9443);
    expect(flags.sshExtraArgs).toEqual(["-o", "ServerAliveInterval=20"]);
    expect(flags.dockerBridge).toBe(true);
    expect(flags.dockerNetworks).toEqual(["coolify"]);
  });

  test("parses diagnose command as non-interactive", () => {
    const flags = parseFlags(["diagnose", "--profile", "ssdnodes2-portainer"]);

    expect(flags.diagnose).toBe(true);
    expect(flags.nonInteractive).toBe(true);
    expect(flags.profile).toBe("ssdnodes2-portainer");
  });
});
