# Paseo Native Migration Report (VPS Home) - Complete

**Date:** 2026-10-23 01:15 ICT
**Host:** `ssh home` -> `ndlvps` (Ubuntu 24.04, User `ndl`)

## 1. Outcome

Paseo is running 100% natively under systemd (`paseo.service`) with full fork compatibility and state restoration.

- **Service Status:** `active (running)`, `enabled` on system boot.
- **Port:** `127.0.0.1:6767` healthy.
- **Public URL:** `https://paseo.ndl.io.vn` (HTTP 200).
- **Server Identity:** Restored to `srv_ypU-wVje_g6I`.
- **All Projects & Workspaces:** Fully loaded:
  - Projects: `tranzlytic`, `workspace`, `tranzlytic-backend`, `tranzlytic-frontend`
  - Workspaces: `wks_58b64b096192b003` (quét toàn bộ codebase), `wks_f704b0d974aa8b32` (workspace)
  - Agents: `d234d11` (quét toàn bộ codebase, opencode/minimax-m3.1-flash-free, status: idle)
- **Active Providers:** All 17 providers available (claude, codex, opencode, pi, deepseek-harness, zs-_, slp-_).
- **Plugins:** All native plugins active (`zai-usage-source`, `paseo-plugin-plantuml`, `zerosub`, `larksub`).

## 2. Root Cause of "Reconnecting to host"

1. **Paseo Home Path:** The original daemon state was under `/home/paseo/.paseo`, which was copied into `/home/ndl/.paseo-home/.paseo`. Initially `PASEO_HOME` was pointing one directory higher (`/home/ndl/.paseo-home`), creating a fresh empty database.
2. **Server ID Mismatch:** The new instance generated a new server-id (`srv_3ABuMt7glbHQ`), causing the client session to reject/loop re-establishing connection with existing workspace sessions mapped to `srv_ypU-wVje_g6I`.
3. **Fork Package Compatibility:** The VPS fork (`release/home-2026-10-21`) uses custom in-process plugin runtimes and protocol schemas (`findSvgIconProblem`, `PluginRuntimeKindSchema`). Installing generic public npm packages caused module load failures. Packages were packed directly from the fork and installed globally into the native Node runtime.
4. **Plugin Paths:** The paths inside `/home/ndl/.paseo-home/.paseo/config.json` referenced the old `/home/paseo` container paths; these were remapped to `/home/ndl/.paseo-home`.
