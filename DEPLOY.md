# Deploying release/rust-preview

This branch is Paseo plus the opt-in Rust components: `paseod` (edge that owns the public port) and `paseo-terminal-worker` (terminal PTY worker). Both are off by default; with no flags the daemon behaves like the stock TypeScript daemon. The Rust core (P4) is not included.

## Prerequisites

- Docker 24+ with buildx (any Linux VPS, linux/amd64 or linux/arm64). Image glibc is Debian bookworm (2.36).
- Bare metal only: Linux with glibc >= 2.36 for the prebuilt binaries (or build them on the host), Node 22, git, and a Rust toolchain >= 1.92 if you build the binaries.
- File watching uses inotify. On a VPS with many projects raise the limits:

```bash
sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512
echo 'fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=512' | sudo tee /etc/sysctl.d/60-paseo.conf
```

## Build the image

`paseo-rs` is a separate repository passed as a named build context. Do not point the context at a dev checkout: its `target/` directory is tens of GB and the whole directory is sent to the builder. Export a clean snapshot first.

```bash
rsync -a --exclude target --exclude .git --exclude sherpa-onnx-prebuilt /path/to/paseo-rs/ /tmp/paseo-rs-src/

# one arch (loads into the local daemon)
docker buildx build -f docker/rust/Dockerfile \
  --build-context paseo-rs=/tmp/paseo-rs-src \
  --platform linux/amd64 --load -t paseo:rust-preview .

# both arches (push to a registry)
docker buildx build -f docker/rust/Dockerfile \
  --build-context paseo-rs=/tmp/paseo-rs-src \
  --platform linux/amd64,linux/arm64 --push -t registry.example.com/paseo:rust-preview .
```

Cross-arch builds under emulation are slow (the Rust stage compiles natively per target). Build on a machine of the target arch when you can, or build on the VPS itself. The binaries land in `<server package>/dist/bin/linux-<x64|arm64>/`, where the TS shims look by default.

## Run with Docker Compose

```yaml
services:
  paseo:
    image: paseo:rust-preview        # or your registry tag
    container_name: paseo
    restart: unless-stopped
    ports:
      - "127.0.0.1:6767:6767"        # put a TLS reverse proxy in front, see docs/docker.md
    environment:
      PASEO_PASSWORD: "change-me"    # required for any reachable deployment
      # PASEO_HOSTNAMES: "paseo.example.com"
      # PASEO_TERMINAL_WORKER: "rust"
      # PASEO_EDGE: "rust"
    volumes:
      - ./paseo-home:/home/paseo     # state (.paseo) and agent credentials
      - ./workspace:/workspace
```

`./paseo-home` and `./workspace` must be writable by uid/gid 1000 (or set `user:`). Agent CLIs are not in the image; see `docs/docker.md` ("Installing Agents"). Reverse proxy, `PASEO_HOSTNAMES` and relay guidance are in `docs/docker.md`; the auth model is in `docs/permissions.md` and `SECURITY.md`. Clients connect with the same `PASEO_PASSWORD`. Without it the daemon accepts unauthenticated control connections.

## Rust flags

Flags are environment variables, read at container start. Unset or any other value means off.

| Flag | Effect |
| --- | --- |
| `PASEO_TERMINAL_WORKER=rust` | Terminals run in `paseo-terminal-worker` (Rust PTY + emulator) instead of the Node worker. The daemon talks to it over stdio JSONL. If the worker dies, its terminals are reported as exited and a new worker starts on the next terminal request. |
| `PASEO_EDGE=rust` | `paseod` owns `PASEO_LISTEN` (public port), serves HTTP/WebSocket and the web UI, and launches the TS daemon on a loopback port behind it. The supervisor restarts `paseod` if it dies. Relay stays off unless you enable it. |

Both can be combined. Overrides: `PASEO_EDGE_BIN`, `PASEO_TERMINAL_WORKER_BIN` point to custom binaries (the bundled ones win for the terminal worker if present).

## Health and logs

```bash
curl -fsS http://127.0.0.1:6767/api/health        # {"status":"ok",...}
docker ps                                          # HEALTHCHECK reports healthy
docker exec -u paseo paseo paseo ls                # CLI inside the container uses PASEO_PASSWORD
docker exec -u paseo paseo paseo terminal create --cwd /workspace --name t
docker logs paseo
docker exec paseo tail -f /home/paseo/.paseo/daemon.log
docker exec paseo ps -eo pid,ppid,args             # check paseod / paseo-terminal-worker are running when flags are on
```

## Upgrade and rollback

- Upgrade: build/pull the new tag, change `image:`, `docker compose up -d`. State in `./paseo-home` is kept (restart persistence verified).
- Rollback step 1 (fastest): remove `PASEO_EDGE` / `PASEO_TERMINAL_WORKER` and `docker compose up -d`. This returns to the TS code paths in the same image.
- Rollback step 2: set `image:` back to the previous tag. Back up `./paseo-home` before upgrading; there are no migrations, but a newer daemon can write fields an older one ignores.
- Open terminals do not survive a restart (this is true with and without the flags).

## Bare metal (no Docker)

```bash
git clone <repo> paseo && cd paseo && git checkout release/rust-preview
npm ci
npm run build:server        # builds protocol/client/server/cli (dist)

# optional Rust binaries, built on this host so glibc matches
(cd /path/to/paseo-rs && CARGO_INCREMENTAL=0 cargo build --release --locked -p paseod -p paseo-terminal-worker)
arch=$(node -p 'process.arch')            # x64 or arm64
mkdir -p packages/server/dist/bin/linux-$arch
cp /path/to/paseo-rs/target/release/{paseod,paseo-terminal-worker} packages/server/dist/bin/linux-$arch/

export PASEO_HOME=/var/lib/paseo PASEO_LISTEN=0.0.0.0:6767 PASEO_PASSWORD=change-me PASEO_WEB_UI_ENABLED=true
# export PASEO_TERMINAL_WORKER=rust PASEO_EDGE=rust
node packages/server/dist/scripts/supervisor-entrypoint.js
```

The web UI needs the app export in the server package (see `docs/development.md`); the Docker image already includes it. Run under systemd with `Restart=always` and the same environment, and apply the inotify sysctls above.

## Known limitations

- Speech (dictation, voice) needs STT/TTS models or provider keys; local sherpa models download on first use and need disk and network. Not exercised in the smoke tests.
- The Rust core (P4: agent/provider hosting in Rust) is not part of this release. The provider-host bridge code is present on the TS side but unused by default.
- Windows is untested. The image and binaries target Linux.
- `PASEO_EDGE=rust` with relay was not tested (relay off).
- Smoke-tested on linux/arm64 (native) for all flag combinations and linux/amd64 (emulated) with flags off and both on; not tested on a real VPS or on real agent providers.
