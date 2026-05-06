# SSH Tunnels Manager

A guided TUI and CLI for creating, saving, monitoring, and debugging SSH tunnels without memorizing every `ssh -L`, `ssh -R`, or `ssh -D` incantation.

SSH tunnels are excellent for reaching private services. They are also easy to misconfigure, forget, collide with local ports, or leave undocumented.

**SSH Tunnels Manager** turns tunnel setup into a repeatable workflow: pick a host, choose a tunnel mode, validate the ports, optionally bridge private Docker services, save the setup as a profile, and manage active sessions from one terminal UI.

> Built with Bun + OpenTUI.

---

## What problem does this solve?

You probably use SSH tunnels when you need to:

- reach a private admin panel on a VPS
- access a service bound to `127.0.0.1` on a remote host
- expose a local dev service temporarily to a remote machine
- create a SOCKS proxy through SSH
- inspect a containerized web app without publishing its ports
- reconnect to the same tunnels repeatedly without rebuilding commands by hand

The raw SSH commands work, but they become annoying once you have multiple servers, local port collisions, Docker-only services, presets, saved profiles, and long-running sessions.

This project wraps those workflows in a small manager.

---

## Features

- Interactive terminal wizard for SSH tunnels
- Supports local, remote, and dynamic forwarding:
  - `-L` local forwarding
  - `-R` remote forwarding
  - `-D` SOCKS proxy forwarding
- Reads SSH aliases from `~/.ssh/config`
- Supports SSH `Include` files
- Local port availability checks
- Suggested fallback ports when a port is already in use
- Service/game presets via `data/service-presets.json`
- Save/load tunnel profiles
- Managed tunnel sessions with:
  - status
  - logs
  - stop controls
  - auto-reconnect support
- Non-interactive mode for scripts and automation
- Optional Docker bridge mode for isolated containers
- Docker network suggestions based on running containers, service names, labels, and port hints
- Optional remote reverse-proxy/domain detection with permission gating
- Dry-run mode for inspecting commands before execution

---

## Why not just write the SSH command manually?

You still can.

This tool is for the cases where the command is only one piece of the workflow.

For example:

```bash
ssh -L 127.0.0.1:18080:127.0.0.1:8080 my-server
```

is fine until you need to remember:

- which host alias to use
- which remote port belongs to which service
- whether the local port is already taken
- whether the remote service is bound to localhost only
- whether the target service is inside a Docker network
- whether this tunnel was already running
- which tunnel profile you used last time
- why the tunnel silently failed

SSH Tunnels Manager keeps those details visible and repeatable.

---

## Example use cases

### Access a private remote dashboard

Forward a remote service to your local machine:

```bash
ssh-tunnels-manager --target my-vps --mode L --local-port 18080 --remote-host 127.0.0.1 --remote-port 8080
```

Then open:

```text
http://127.0.0.1:18080
```

---

### Create a SOCKS proxy through a server

```bash
ssh-tunnels-manager --target my-vps --mode D --local-port 1080
```

Then configure your browser or application to use:

```text
socks5://127.0.0.1:1080
```

---

### Reach an isolated Docker service

Some containers intentionally do not publish ports to the host.

In Docker bridge mode, SSH Tunnels Manager can start a temporary Caddy sidecar on the remote server, attach it to the target Docker network, and forward traffic through SSH without exposing the app publicly.

Conceptually:

```text
Local machine
  → SSH tunnel
  → remote loopback-only bridge port
  → temporary Caddy sidecar
  → private Docker network
  → target container
```

This is useful for services like Portainer, Immich, internal dashboards, test apps, or admin tools that should stay private.

---

## Install

Clone the repo:

```bash
git clone https://github.com/YOUR_USERNAME/ssh-tunnels-manager.git
cd ssh-tunnels-manager
```

Install dependencies:

```bash
bun i
```

---

## Run the TUI

```bash
bun run start
```

Or, if configured:

```bash
bun dev
```

---

## Non-interactive usage

```bash
bun run src/index.ts \
  --non-interactive \
  --target my-vps \
  --mode L \
  --local-port 18080 \
  --remote-host 127.0.0.1 \
  --remote-port 8080
```

Common options:

```text
--target <alias|user@host>
--mode <L|R|D>
--local-port <port>
--remote-host <host>
--remote-port <port>
--bind-address <ip>
--profile <name>
--dry-run
--skip-preflight
--auto-reconnect
--docker-bridge
--docker-network <name>
--upstream-target <host:port>
--probe-permission <yes|always|no>
```

Use:

```bash
bun run start --help
```

for the full option list.

---

## Tunnel modes

### Local forwarding: `-L`

Use this when you want to access a remote service locally.

```text
localhost:LOCAL_PORT → SSH → REMOTE_HOST:REMOTE_PORT
```

Example:

```bash
ssh-tunnels-manager --mode L --local-port 15432 --remote-host 127.0.0.1 --remote-port 5432
```

---

### Remote forwarding: `-R`

Use this when you want a remote machine to reach a service running on your local machine.

```text
remote:REMOTE_PORT → SSH → localhost:LOCAL_PORT
```

Example:

```bash
ssh-tunnels-manager --mode R --remote-port 3000 --local-port 3000
```

---

### Dynamic forwarding: `-D`

Use this when you want a SOCKS proxy through the SSH server.

```text
local SOCKS proxy → SSH → target chosen by client application
```

Example:

```bash
ssh-tunnels-manager --mode D --local-port 1080
```

---

## Docker bridge mode

Docker bridge mode is for services that are reachable from inside a Docker network but not published to the host.

Example:

```bash
bun run start \
  --non-interactive \
  --target my-vps \
  --mode L \
  --local-port 19000 \
  --remote-port 9000 \
  --docker-bridge \
  --docker-network portainer_default \
  --upstream-target portainer:9000
```

The remote side starts a temporary bridge container similar to:

```text
temporary Caddy
  attached to Docker network
  reverse_proxy → target-service:port
  published only on remote 127.0.0.1
```

The SSH tunnel then forwards your local port to that remote loopback-only bridge.

The target service’s own ports do not need to be published to the public host.

---

## Profiles

Profiles let you save repeatable tunnel configurations.

Stored profiles live under:

```text
~/.config/ssh-tunnels-manager
```

Profiles are intended to store tunnel metadata, not secrets.

A profile may include:

- target SSH alias
- tunnel mode
- local port
- remote host
- remote port
- bind address
- Docker bridge settings
- selected preset
- reconnect preference

Runtime state should not be persisted into profiles.

For example, generated bridge container names, active process IDs, temporary ports, and mutated runtime forwarding targets should remain session-only.

---

## Logs and diagnostics

The manager is designed to expose enough information to debug the first broken hop.

Useful diagnostics include:

- loaded profile data
- normalized runtime config
- generated SSH command
- generated Docker bridge command
- local port checks
- remote bridge container status
- remote Docker logs
- SSH process status
- local curl checks
- remote curl checks

The goal is to avoid vague tunnel failures like:

```text
Something did not connect.
```

and instead show the layer that failed:

```text
Local port is busy.
Remote bridge container failed.
Docker upstream target did not resolve.
SSH forwarding was rejected.
Remote service returned HTTP 502.
```

---

## Build a binary

```bash
bun run build
```

Expected output:

```text
dist/ssh-tunnels-manager
```

The project is intended to be distributable as a single executable.

---

## Test

```bash
bun test
```

---

## Security model

SSH Tunnels Manager does not try to replace SSH security. It helps you compose SSH workflows more safely.

Design principles:

- prefer loopback binds by default
- avoid exposing remote bridge ports publicly
- keep Docker bridge services temporary
- do not store secrets in profiles
- ask before running optional remote discovery
- make generated commands inspectable
- support dry runs

When Docker bridge mode is used, the bridge port should bind to remote `127.0.0.1` only, so the service remains reachable through SSH rather than the public network.

---

## Limitations

- SSH tunneling is TCP-based.
- UDP-only game servers or services may not work through standard SSH forwarding.
- Docker bridge mode currently targets HTTP services through a temporary reverse proxy.
- Remote discovery depends on SSH permissions and available remote tools.
- Some applications may require extra origin, callback URL, or host-header configuration.

---

## Roadmap ideas

- Local Caddy sidecar for friendly `.localhost` names
- Better tunnel health checks
- Profile repair/migration tooling
- Richer Docker service discovery
- Exportable command snippets
- More service presets
- Config validation schema
- Packaged releases for common platforms

---

## Development

Install dependencies:

```bash
bun install
```

Run:

```bash
bun run start
```

Test:

```bash
bun test
```

Build:

```bash
bun run build
```

---

## Name

Yes, **SSH Tunnels Manager** is extremely literal.

That is not necessarily bad.

It says what it does.
