#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PASEO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(dirname "$DEFAULT_PASEO_DIR")}"
PASEO_DIR="${PASEO_DIR:-$DEFAULT_PASEO_DIR}"
SLP_DIR="$WORKSPACE_DIR/paseo-slp"
ZEROSUB_DIR="$WORKSPACE_DIR/zerosub"
PLANTUML_DIR="$WORKSPACE_DIR/paseo-plugin-plantuml"

echo "==> [1/6] Cloning ecosystem repositories into $WORKSPACE_DIR ..."
mkdir -p "$WORKSPACE_DIR"

if [ ! -d "$PASEO_DIR/.git" ]; then
  git clone https://github.com/luongndcoder/paseo.git "$PASEO_DIR"
fi

if [ ! -d "$SLP_DIR/.git" ]; then
  git clone https://github.com/luongndcoder/paseo-slp.git "$SLP_DIR"
fi

if [ ! -d "$ZEROSUB_DIR/.git" ]; then
  git clone https://github.com/luongndcoder/zerosub.git "$ZEROSUB_DIR"
fi

if [ ! -d "$PLANTUML_DIR/.git" ]; then
  git clone https://github.com/luongndcoder/paseo-plugin-plantuml.git "$PLANTUML_DIR"
fi

echo "==> [2/6] Installing & building Paseo monorepo + Web UI ..."
cd "$PASEO_DIR"
npm install
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/client
npm run build --workspace=@getpaseo/cli
npm run build --workspace=@getpaseo/server

(
  cd "$PASEO_DIR/packages/app"
  npx expo export --platform web
  mkdir -p ../server/dist/server/web-ui
  cp -R dist/* ../server/dist/server/web-ui/
)

echo "==> [3/6] Building plugins (zerosub & paseo-plugin-plantuml) ..."
if [ -f "$ZEROSUB_DIR/package.json" ]; then
  (cd "$ZEROSUB_DIR" && npm install && npm run build || true)
fi

if [ -f "$PLANTUML_DIR/package.json" ]; then
  (cd "$PLANTUML_DIR" && npm install && npm run build || true)
fi

echo "==> [4/6] Configuring ~/.paseo/config.json plugins ..."
mkdir -p "$HOME/.paseo"
if [ ! -f "$HOME/.paseo/config.json" ]; then
  echo "{}" > "$HOME/.paseo/config.json"
fi

node -e '
const fs = require("fs");
const configPath = process.argv[1];
const plantumlPath = process.argv[2];
const zerosubPath = process.argv[3];
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
raw.plugins = raw.plugins || {};
raw.plugins["paseo-plugin-plantuml"] = {
  source: "directory",
  path: plantumlPath,
  enabled: true,
};
raw.plugins["zerosub"] = {
  source: "directory",
  path: zerosubPath,
  enabled: true,
};
fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
' "$HOME/.paseo/config.json" "$PLANTUML_DIR" "$ZEROSUB_DIR"

echo "==> [5/6] Setting up SLP Python environment & applying SLP providers ..."
mkdir -p "$HOME/.claude/skills"
if [ ! -x "$HOME/.claude/skills/.venv/bin/python3" ]; then
  python3 -m venv "$HOME/.claude/skills/.venv"
fi
"$HOME/.claude/skills/.venv/bin/pip" install --quiet --upgrade pip pyyaml jsonschema

export PASEO_CLI="$PASEO_DIR/packages/cli/bin/paseo"
(
  cd "$SLP_DIR"
  ./bin/slp-build --apply
)

echo "==> [6/6] Installing & starting macOS LaunchAgent (com.paseo.daemon) ..."
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PASEO_DIR/.dev/paseo-home/models/local-speech"
NODE_BIN="$(command -v node)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.paseo.daemon.plist"

cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NVIDIA_API_KEY</key>
		<string></string>
		<key>PASEO_DICTATION_ENABLED</key>
		<string>true</string>
		<key>PASEO_DICTATION_LANGUAGE</key>
		<string>vi</string>
		<key>PASEO_DICTATION_STT_PROVIDER</key>
		<string>local</string>
		<key>PASEO_HOME</key>
		<string>$HOME/.paseo</string>
		<key>PASEO_LISTEN</key>
		<string>127.0.0.1:6767</string>
		<key>PASEO_LOCAL_MODELS_DIR</key>
		<string>$PASEO_DIR/.dev/paseo-home/models/local-speech</string>
		<key>PASEO_LOG_FILE_PATH</key>
		<string>$PASEO_DIR/.dev/paseo-service-daemon.log</string>
		<key>PASEO_NODE_ENV</key>
		<string>development</string>
		<key>PASEO_WEB_UI_ENABLED</key>
		<string>true</string>
		<key>PATH</key>
		<string>/opt/homebrew/bin:$HOME/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.paseo.daemon</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>--import</string>
		<string>tsx</string>
		<string>scripts/dev-runner.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$PASEO_DIR/.dev/paseo-service.log</string>
	<key>StandardOutPath</key>
	<string>$PASEO_DIR/.dev/paseo-service.log</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>WorkingDirectory</key>
	<string>$PASEO_DIR/packages/server</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.paseo.daemon" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/com.paseo.daemon"

echo ""
echo "✅ Hoàn tất! Paseo + SLP đã sẵn sàng tại: http://localhost:6767"
