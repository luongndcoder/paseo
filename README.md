<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="SETUP_NEW_MACHINE.md">Machine Setup Guide</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

> **Enhanced Fork (`luongndcoder/paseo`)**: Integrated with offline on-device Vietnamese speech recognition (`sherpa-onnx`), visual NDL-Git tool suite (`ndl-git`, shortcut `Cmd + 9`), live PlantUML diagram rendering, ZeroSub multi-account failover (`luongndcoder/zerosub`), and the **SLP (`luongndcoder/paseo-slp`)** multi-agent orchestration framework.
> 👉 For the step-by-step setup guide on a fresh machine, see **[SETUP_NEW_MACHINE.md](SETUP_NEW_MACHINE.md)** or run `bash scripts/setup-new-machine.sh`.

<p align="center">
  <a href="https://github.com/getpaseo/paseo/stargazers">
    <img src="https://img.shields.io/github/stars/getpaseo/paseo?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/getpaseo/paseo/releases">
    <img src="https://img.shields.io/github/v/release/getpaseo/paseo?style=flat&logo=github" alt="GitHub release">
  </a>
  <a href="https://x.com/moboudra">
    <img src="https://img.shields.io/badge/%40moboudra-555?logo=x" alt="X">
  </a>
  <a href="https://discord.gg/jz8T2uahpH">
    <img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord">
  </a>
  <a href="https://www.reddit.com/r/PaseoAI/">
    <img src="https://img.shields.io/badge/Reddit-555?logo=reddit" alt="Reddit">
  </a>
</p>

<p align="center">One interface for Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, and Muse Code agents.</p>

<p align="center">
  <img src="https://paseo.sh/hero-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://paseo.sh/mobile-mockup.png" alt="Paseo mobile app" width="100%">
</p>

Paseo is an open source agentic development environment for desktop, mobile, web, and CLI. Open the desktop app and work: agents, editor, terminals, diffs, pull requests, and a browser in one window. Run many agents at once, each in its own worktree, on one machine or several. The mobile app is the full app, native on iOS and Android.

- **Parallel agents:** Run many agents at once, each in its own worktree.
- **Built-in orchestration:** Agents in Paseo can create worktrees, launch other agents, and talk to them, across providers.
- **Complete development workflow:** Edit files, review diffs, open pull requests, and run terminals, in split panes you arrange how you want.
- **Self-hosted:** Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider:** Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, and Muse Code through the same interface. Pick the right model for each job.
- **Voice control:** Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device:** iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.
- **Privacy-first:** Paseo doesn't have any telemetry, tracking, or forced log-ins.

[Run parallel tasks in Paseo](https://paseo.sh/docs/parallel-development): start agents in separate worktrees, review their diffs, run each app, and check it in the built-in browser.

---

## Enhanced Fork Features

This custom fork (`luongndcoder/paseo`) introduces high-productivity extensions tailored for local-first development, rich Git workflows, and multi-agent systems:

- 🎙️ **Offline Vietnamese Voice Dictation (`sherpa-onnx`)**: Low-latency, privacy-first on-device speech-to-text with Silero VAD, streaming real-time transcription directly into the prompt composer.
- 🌿 **NDL-Git Tool Suite (`ndl-git`, `Cmd + 9`)**: A full-featured visual Git control center featuring:
  - Interactive multi-branch swimlane commit graph with refs, tags, and stashes.
  - Side-by-side split diff viewer with single-hunk staging (`+ Stage Hunk`) and rollback (`↺ Rollback Hunk`).
  - 3-Way merge conflict resolver (Yours / Merged Result editable / Theirs) with 1-click conflict block acceptance.
  - Comprehensive stash stack inspector (`apply`, `pop`, `drop`, `branch`).
- 📊 **PlantUML Live Preview**: Native rendering of `.puml` files and embedded Markdown diagrams.
- 🤖 **SLP Multi-Agent Orchestration (`paseo-slp`)**: Hierarchical coordination with Supervisor, Lead Planner, Peer Builders, and deterministic verification tools (`slp-verify`, `slp-evidence`).
- 🔄 **ZeroSub Account Rotation (`zerosub`)**: Automatic failover across multiple Claude Code, Codex and OpenCode (Go/Zen) API profiles to prevent quota interruption.

---

## System Architecture

### 1. Paseo Architecture Overview

The diagram below illustrates how client applications (Desktop, Web, Mobile, CLI) connect to the Paseo Daemon via an encrypted WebSocket RPC protocol, coordinating local offline Vietnamese voice transcription, NDL-Git tools (`ndl-git`), the extensibility plugin system, and multi-agent systems (SLP, Claude, Codex, Antigravity):

```mermaid
flowchart TD
    subgraph Clients["Clients Layer"]
        Desktop["Desktop App (Electron / macOS / Windows / Linux)"]
        Web["Web Client (React / Vite)"]
        Mobile["Mobile App (iOS / Android Expo Native)"]
        CLI["CLI Tool (@getpaseo/cli)"]
    end

    subgraph ProtocolLayer["Protocol & Security Layer"]
        WSRPC["WebSocket RPC Protocol (@getpaseo/protocol)"]
        Relay["Encrypted Relay / E2EE Pairing (@getpaseo/relay)"]
    end

    subgraph CoreDaemon["Paseo Core Daemon (@getpaseo/server)"]
        SessionMgr["Session Manager & Worktree Engine"]

        subgraph VoiceEngine["Speech & Voice Engine"]
            VAD["Silero VAD / Audio Chunking"]
            SherpaONNX["Sherpa-ONNX Vietnamese STT (Offline)"]
            TTS["Text-to-Speech & Realtime Streaming"]
        end

        subgraph GitEngine["NDL-Git Engine (Cmd + 9)"]
            GitGraph["Swimlane Commit Graph & Stashes"]
            SplitDiff["Side-by-Side Split Diff & Hunk Staging"]
            MergeResolver["3-Way Conflict Resolver Engine"]
        end

        subgraph PluginHost["Plugin Runtime Host"]
            PluginRegistry["Plugin Discovery & Loader"]
            ProviderHost["Provider Adapter Host"]
            UsageHost["Usage Sources Aggregator"]
        end

        PlantUML["PlantUML Server / Local Render Engine"]
    end

    subgraph AgentEcosystem["Agent Ecosystem & Providers"]
        subgraph Providers["Providers & Local CLIs"]
            Claude["Claude Code CLI"]
            Codex["OpenAI Codex CLI"]
            Antigravity["Antigravity CLI (agy)"]
            Copilot["GitHub Copilot CLI"]
            OpenCode["OpenCode / Pi CLI"]
            Muse["Muse Code CLI"]
        end

        subgraph SLP["SLP Orchestration (Supervisor / Lead / Peers)"]
            Supervisor["SLP Supervisor"]
            Lead["SLP Lead Planner"]
            Peers["SLP Peer Builders & Testers"]
            Verify["slp-verify & Deterministic Evidence"]
        end
    end

    Clients <--> ProtocolLayer
    ProtocolLayer <--> CoreDaemon
    CoreDaemon <--> AgentEcosystem
    PluginHost <--> Providers
    SessionMgr <--> SLP
```

---

### 2. Vietnamese Voice & Agent Session Execution Flow

Sequence diagram demonstrating the local offline audio pipeline from microphone input to Sherpa-ONNX streaming transcript, prompt composition, worktree provisioning, and agent execution:

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer (User)
    participant Client as Paseo Client (Desktop / Web / Mobile)
    participant Daemon as Paseo Daemon (@getpaseo/server)
    participant Sherpa as Sherpa-ONNX Engine (Local STT)
    participant Session as Agent Session Manager
    participant Provider as Coding Agent (Claude / Codex / Antigravity)

    User->>Client: Press Mic button or Voice Hotkey
    Client->>Client: Capture 16kHz PCM audio stream via Audio Worklet
    Client->>Daemon: Stream audio chunks via WebSocket RPC
    Daemon->>Sherpa: Process Silero VAD & decode offline Vietnamese speech
    Sherpa-->>Daemon: Partial transcript ("create a new route...")
    Daemon-->>Client: Broadcast realtime text to Prompt Composer
    Client-->>User: Live streaming text display in composer

    User->>Client: Stop speaking / Press Send
    Sherpa-->>Daemon: Final Vietnamese speech transcript
    Client->>Daemon: Dispatch normalized prompt to Session
    Daemon->>Session: Provision isolated Git worktree
    Session->>Provider: Launch agent process with repo context
    Provider-->>Daemon: Stream stdout, reasoning chunks & file patches
    Daemon-->>Client: Live streaming response, diffs & log events
    User->>Client: Open NDL-Git Tool Window (Cmd + 9) to review diff & merge
```

---

### 3. NDL-Git Tool Window & 3-Way Merge Conflict Resolver

Visual Git management tool (NDL-Git) integrated directly into Paseo:

```mermaid
flowchart LR
    subgraph WorkingTree["Git Workspace State"]
        A["Local Changes (Uncommitted)"]
        B["Merge / Rebase Conflict Markers"]
        C["Git Stash Stack (stash@{0})"]
    end

    subgraph NdlGitWindow["NDL-Git Tool Window (Cmd + 9)"]
        Graph["Swimlane Commit Graph<br/>(Branch Tree, Tags, Authors)"]
        Split["Side-by-Side Split Diff<br/>(+ Stage Hunk / ↺ Rollback Hunk)"]
        Conflict["3-Way Conflict Resolver<br/>(Yours | Result | Theirs)"]
    end

    subgraph Actions["1-Click Visual Actions"]
        Act1["Cherry-pick / Revert / Reword"]
        Act2["Stage / Rollback Individual Hunks"]
        Act3["Accept Yours / Accept Theirs / Accept Both"]
        Act4["Save & Mark Resolved (git add)"]
    end

    A --> Split
    B --> Conflict
    C --> Graph

    Split --> Act2
    Conflict --> Act3 --> Act4
    Graph --> Act1
```

---

## Sponsors

<!-- Sponsors: one cell per sponsor in the order of packages/website/src/data/sponsors.ts, then "become a sponsor" cells up to three. -->
<table>
  <tr>
    <td align="center" width="33%"><a href="https://hoplite.sh/?utm_source=paseo&utm_medium=readme&utm_campaign=sponsor"><picture><source media="(prefers-color-scheme: dark)" srcset="packages/website/public/sponsors/hoplite-on-dark.svg"><img src="packages/website/public/sponsors/hoplite-on-light.svg" alt="Hoplite" height="56"></picture></a><br><sub>Cloud coding agents</sub></td>
    <td align="center" width="33%"><a href="https://paseo.sh/sponsor">Become a sponsor</a></td>
    <td align="center" width="33%"><a href="https://paseo.sh/sponsor">Become a sponsor</a></td>
  </tr>
</table>

## Plugins

> 💡 **For architecture diagrams and registry publishing guide, see: [plugins/README.md](plugins/README.md)**

Plugins run on the daemon and show up in every client you connect, with the same UI on desktop, web,
iOS, and Android. Write a plugin once and it is on your phone.

- **UI:** screens, sidebar items, workspace panels, Command Center items, slash commands, composer pills, attachment sources, timeline items, themes.
- **Agent lifecycle:** change configuration, environment, and MCP servers, answer permissions, follow up when a turn ends.
- **Providers:** add a coding agent as a provider.

Install from the registry with `paseo plugin add owner/slug`, or from Git or a local directory.

**[Browse plugins](https://paseo.sh/plugins)** · **[Plugin docs](https://paseo.sh/docs/plugins)**

Plugins run with access to your daemon machine and inside connected clients; install only code you trust.

## Getting Started

Paseo runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it.

### Prerequisites

You need at least one agent CLI installed and configured with your credentials:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [GitHub Copilot](https://github.com/features/copilot/cli/)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Pi](https://pi.dev)
- [Antigravity](https://paseo.sh/docs/supported-providers#antigravity)
- [Muse Code](https://paseo.sh/docs/muse-code)

### Desktop app (recommended)

Download it from [paseo.sh/download](https://paseo.sh/download) or the [GitHub releases page](https://github.com/getpaseo/paseo/releases). Open the app and the daemon starts automatically. Nothing else to install.

To connect from your phone, open **Settings → your host → Pair Device**.

### Server

For a server, a VM, or any machine without the desktop app. Install the CLI and start the daemon:

```bash
npm install -g @getpaseo/cli
paseo
```

Paseo starts, then asks whether to enable the end-to-end encrypted relay for device pairing. If you decline, connect directly over TCP, Tailscale, or another VPN. The desktop, mobile, and web apps connect to this daemon like any other host.

For full setup and configuration, see:

- [Docs](https://paseo.sh/docs)
- [Connectivity guide](https://paseo.sh/docs/connectivity)
- [Configuration reference](https://paseo.sh/docs/configuration)

### Docker

Run the Paseo daemon and self-hosted web UI in Docker:

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

Open `http://localhost:6767` after it starts. Extend the base image with the agent CLIs you use, then provide credentials through environment variables or the persistent `/home/paseo` volume. See the [Docker documentation](docs/docker.md) for full setup details.

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.5 --worktree feature-x "implement feature X"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task

# run on a remote daemon; --cwd is a path on that host
paseo run --host workstation.local:6767 --cwd /workspace "run the full test suite"
```

See the [full CLI reference](https://paseo.sh/docs/cli) for more.

## TypeScript SDK

Build issue integrations, dashboards, and orchestration services with `@getpaseo/client`:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

See the [SDK quickstart](https://paseo.sh/docs/sdk/quickstart), [recipes](https://paseo.sh/docs/sdk/recipes), and [API reference](https://paseo.sh/docs/sdk/reference).

## Skills

Skills teach your agent to use Paseo to orchestrate other agents.

```bash
npx skills add getpaseo/paseo
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay transport and encryption used by the daemon and clients
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website

# build the server stack
npm run build:server

# repo-wide checks
npm run typecheck
```

## Support Paseo

Paseo is an independent project used by tens of thousands of developers daily, built by one person and funded by the people who use it. Support the work on [GitHub Sponsors](https://github.com/sponsors/boudra). Companies can [sponsor Paseo](https://paseo.sh/sponsor#spot) monthly and have their logo shown at the top of this README and on the paseo.sh homepage and docs.

## Related projects

- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) — official distributed relay, written in Elixir
- [paseo-vscode](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) — VS Code extension

## License

Apache-2.0
