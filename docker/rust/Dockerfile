# syntax=docker/dockerfile:1
#
# Paseo daemon image that also ships the Rust binaries (paseod edge and
# paseo-terminal-worker). Both are opt-in at runtime:
#   PASEO_TERMINAL_WORKER=rust   Rust terminal worker
#   PASEO_EDGE=rust              paseod owns the public port
#
# Build (paseo-rs is a separate repository, passed as a named context):
#   docker buildx build -f docker/rust/Dockerfile \
#     --build-context paseo-rs=/path/to/paseo-rs \
#     --platform linux/amd64,linux/arm64 -t paseo:rust-preview .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1-bookworm

FROM ${RUST_IMAGE} AS rust-builder
ARG TARGETARCH
ENV CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/cargo-target
# The 30 GB target/ directory of a dev checkout stays out of the build: the
# source is bind-mounted read-only and only the files cargo opens are synced.
RUN --mount=type=bind,from=paseo-rs,target=/src \
    --mount=type=cache,target=/usr/local/cargo/registry,id=paseo-cargo-registry-${TARGETARCH} \
    --mount=type=cache,target=/cargo-target,id=paseo-cargo-target-${TARGETARCH} \
    set -eux; \
    cd /src; \
    cargo build --release --locked -p paseod -p paseo-terminal-worker; \
    mkdir -p /out; \
    install -m 0755 /cargo-target/release/paseod /cargo-target/release/paseo-terminal-worker /out/

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG PASEO_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    if [ -n "${PASEO_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${PASEO_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/plugin --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/paseo \
    PASEO_HOME=/home/paseo/.paseo \
    PASEO_LISTEN=0.0.0.0:6767 \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/paseo/.claude \
    CODEX_HOME=/home/paseo/.codex \
    XDG_CONFIG_HOME=/home/paseo/.config \
    XDG_DATA_HOME=/home/paseo/.local/share \
    XDG_STATE_HOME=/home/paseo/.local/state \
    XDG_CACHE_HOME=/home/paseo/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
	npm install -g /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/paseo-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "paseo" ]; then \
      groupmod --new-name paseo "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 paseo; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "paseo" ]; then \
      usermod --login paseo --gid paseo --home /home/paseo --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid paseo --create-home --home-dir /home/paseo --shell /bin/bash paseo; \
    fi; \
    mkdir -p \
      /workspace \
      "$PASEO_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R paseo:paseo /home/paseo /workspace

# The TS shims look for binaries in <server package>/dist/bin/<platform>-<arch>/
# (process.arch naming: x64 / arm64). The npm "files" list leaves dist/bin out,
# so the binaries are installed after the tarball install.
ARG TARGETARCH
COPY --from=rust-builder /out/ /tmp/rust-bin/
RUN set -eux; \
    case "${TARGETARCH}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac; \
    dest="$(npm root -g)/@getpaseo/server/dist/bin/linux-${node_arch}"; \
    mkdir -p "$dest"; \
    install -m 0755 /tmp/rust-bin/paseod /tmp/rust-bin/paseo-terminal-worker "$dest/"; \
    rm -rf /tmp/rust-bin; \
    test "$(node -p 'process.arch')" = "${node_arch}"

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/paseo-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/paseo"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.PASEO_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
