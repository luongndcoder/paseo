#!/bin/bash
set -euo pipefail

service_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PASEO_NODE_ENV=development
export PASEO_LOCAL_MODELS_DIR="$service_repo_root/.dev/paseo-home/models/local-speech"
export PASEO_DICTATION_ENABLED=true
export PASEO_DICTATION_STT_PROVIDER=local
export PASEO_DICTATION_LANGUAGE=vi
export PASEO_LOG_FILE_PATH="$service_repo_root/.dev/paseo-service-daemon.log"

# Keep the local provider selection when dotenv loads the server's environment.
export NVIDIA_API_KEY=""

cd "$service_repo_root/packages/server"
exec /opt/homebrew/bin/node --import tsx scripts/dev-runner.ts
