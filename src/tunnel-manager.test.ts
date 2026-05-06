import { describe, expect, test } from "bun:test";
import { buildSshArgs } from "./tunnel-manager.ts";

describe("buildSshArgs", () => {
  test("builds local forward command", () => {
    const args = buildSshArgs({
      id: "a",
      name: "demo",
      mode: "L",
      target: { alias: "ssdnodes2", destination: "ssdnodes2" },
      bindAddress: "127.0.0.1",
      localPort: 19443,
      remoteHost: "127.0.0.1",
      remotePort: 9443,
      sshExtraArgs: [],
      autoReconnect: true,
    });

    expect(args).toEqual([
      "ssh",
      "-N",
      "-L",
      "127.0.0.1:19443:127.0.0.1:9443",
      "ssdnodes2",
    ]);
  });

  test("builds dynamic command", () => {
    const args = buildSshArgs({
      id: "b",
      name: "dyn",
      mode: "D",
      target: { destination: "user@example.com" },
      bindAddress: "127.0.0.1",
      localPort: 1080,
      dynamicPort: 1080,
      sshExtraArgs: ["-o", "ServerAliveInterval=20"],
      autoReconnect: true,
    });

    expect(args).toEqual([
      "ssh",
      "-N",
      "-D",
      "127.0.0.1:1080",
      "-o",
      "ServerAliveInterval=20",
      "user@example.com",
    ]);
  });
});
