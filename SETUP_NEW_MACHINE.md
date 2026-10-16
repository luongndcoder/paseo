# Hướng Dẫn Cài Đặt & Tích Hợp Hệ Sinh Thái Paseo + SLP Trên Máy Mới (macOS)

Tài liệu này hướng dẫn cài đặt trọn bộ hệ sinh thái **Paseo + SLP** từ đầu trên một máy Mac mới, bao gồm:

1. **Paseo (`paseo`)** — Hệ thống Paseo kèm:
   - **Dictation Tiếng Việt Local (`sherpa-onnx`)**: Nhận diện giọng nói tiếng Việt offline + hiển thị chữ realtime khi đang đọc.
   - **NDL-Git Tool Window (`ndl-git`, `Cmd + 9`)**: Swimlane Commit Graph, Branch/Tag/Stash tree, Side-by-Side Split Diff, Hunk Stage/Rollback, 3-Way Merge Conflict Resolver, Git Blame, và File Explorer Search.
   - **PlantUML Native Render**: Xem trực tiếp sơ đồ PlantUML trong khung chat Markdown và trình xem file `.puml` / `.plantuml`.
   - **Workspace UI**: Cây thư mục Agent trên sidebar, hiển thị `zero-sub`, và menu mở nhanh tinh gọn (**VS Code** & **Finder**).
2. **SLP (`paseo-slp`)** — Hệ thống điều phối đa tác tử **SLP (Supervisor / Lead / Peers)** kèm bộ công cụ kiểm chứng tất định (`slp-verify`, `slp-evidence`, `slp-guard.py`, `slp-conformance`).
3. **ZeroSub (`zerosub`)** — Plugin quản lý nhiều tài khoản Claude Code & Codex song song, tự động chuyển đổi (auto-failover) khi chạm hạn mức.
4. **PlantUML Plugin (`paseo-plugin-plantuml`)** — Plugin render PlantUML cho Paseo daemon.

---

## Cách 1: Chạy Script Tự Động (Khuyên dùng)

Chọn một thư mục workspace bất kỳ (ví dụ `~/workspace`), clone repo `paseo` và chạy script cài đặt tự động:

```bash
export WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/workspace}"
mkdir -p "$WORKSPACE_DIR" && cd "$WORKSPACE_DIR"

git clone https://github.com/luongndcoder/paseo.git
cd paseo
bash scripts/setup-new-machine.sh
```

Script `scripts/setup-new-machine.sh` sẽ tự động nhận diện thư mục cha (`$WORKSPACE_DIR`), clone thêm `paseo-slp`, `zerosub`, `paseo-plugin-plantuml` vào cùng `$WORKSPACE_DIR`, cài dependencies, build toàn bộ packages + Web UI, cấu hình plugin, apply cấu hình `paseo-slp`, và đăng ký `LaunchAgent` (`com.paseo.daemon`) để Paseo tự chạy nền ở địa chỉ `http://localhost:6767`.

---

## Cách 2: Cài Đặt Thủ Công Từng Bước

### Bước 1: Chuẩn bị môi trường cơ bản (Prerequisites)

Đảm bảo máy đã cài đặt:

- **Homebrew**: `/opt/homebrew/bin/brew`
- **Node.js >= 22** & **npm** (`brew install node`)
- **Python 3.11+** (`brew install python`)
- **Các Agent CLI** cần dùng:
  - Claude Code (`claude`)
  - OpenAI Codex (`codex`)
  - Antigravity (`agy`)
  - OpenCode (`opencode`) / Pi (`pi`) (tuỳ chọn)

> [!WARNING]
> Nếu máy từng cài `@getpaseo/cli` qua Homebrew (`brew install paseo` bản cũ `0.10.x`), hãy dừng daemon cũ trước để tránh xung đột cổng `6767`:
>
> ```bash
> paseo daemon stop || true
> ```

---

### Bước 2: Clone 4 Repository vào thư mục Workspace chung

```bash
export WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# 1. Paseo (nhánh main đã tích hợp đầy đủ tính năng)
git clone https://github.com/luongndcoder/paseo.git

# 2. Hệ thống Orchestration SLP (Supervisor / Lead / Peers)
git clone https://github.com/luongndcoder/paseo-slp.git

# 3. Plugin ZeroSub (Multi-subscription Claude/Codex)
git clone https://github.com/luongndcoder/zerosub.git

# 4. Plugin PlantUML
git clone https://github.com/luongndcoder/paseo-plugin-plantuml.git
```

---

### Bước 3: Cài đặt & Build Paseo + Web UI

```bash
cd "$WORKSPACE_DIR/paseo"

# Cài đặt dependencies cho toàn bộ monorepo
npm install

# Build thứ tự các workspace core: protocol -> client -> cli -> server
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/client
npm run build --workspace=@getpaseo/cli
npm run build --workspace=@getpaseo/server

# Xuất bản Web UI từ packages/app và chép vào server dist
cd packages/app
npx expo export --platform web
mkdir -p ../server/dist/server/web-ui
cp -R dist/* ../server/dist/server/web-ui/
cd "$WORKSPACE_DIR/paseo"
```

> [!TIP]
> Mô hình nhận diện giọng nói tiếng Việt (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`, ~35MB) sẽ được Paseo **tự động tải về và kiểm tra SHA-256** vào thư mục `.dev/paseo-home/models/local-speech` ngay lần đầu bật tính năng đọc giọng nói tiếng Việt.

---

### Bước 4: Build Plugins (`zerosub` & `paseo-plugin-plantuml`)

```bash
# Build ZeroSub
cd "$WORKSPACE_DIR/zerosub"
npm install && npm run build

# Build PlantUML Plugin
cd "$WORKSPACE_DIR/paseo-plugin-plantuml"
npm install && npm run build
```

Đảm bảo `~/.paseo/config.json` đã khai báo 2 plugin này:

```json
{
  "plugins": {
    "paseo-plugin-plantuml": {
      "source": "directory",
      "path": "<WORKSPACE_DIR>/paseo-plugin-plantuml",
      "enabled": true
    },
    "zerosub": {
      "source": "directory",
      "path": "<WORKSPACE_DIR>/zerosub",
      "enabled": true
    }
  }
}
```

---

### Bước 5: Cài đặt Hệ thống Điều phối SLP (`paseo-slp`)

Hệ thống `paseo-slp` tự động nhận diện đường dẫn theo vị trí thư mục hiện tại và sử dụng Python virtualenv tại `~/.claude/skills/.venv` với 2 thư viện `pyyaml` và `jsonschema`.

```bash
# 1. Tạo Python venv cho SLP tools & hooks
mkdir -p ~/.claude/skills
python3 -m venv ~/.claude/skills/.venv
~/.claude/skills/.venv/bin/pip install --upgrade pip pyyaml jsonschema

# 2. Chạy bộ test kiểm tra của SLP
cd "$WORKSPACE_DIR/paseo-slp"
./bin/slp-build
~/.claude/skills/.venv/bin/python3 -m unittest discover -s tests -v

# 3. Áp dụng cấu hình SLP vào ~/.paseo/config.json, ~/.claude/skills và ~/.gemini/config/agents
./bin/slp-build --apply
```

Khi chạy `./bin/slp-build --apply`, hệ thống sẽ:

- Tự động tìm Paseo CLI ở thư mục ngang hàng (`$WORKSPACE_DIR/paseo/packages/cli/bin/paseo`) hoặc qua biến môi trường `PASEO_CLI`.
- Sinh toàn bộ cấu hình role (`build/claude/*.settings.json`, `build/claude/*.policy.json`, `build/codex/catalog.json`, `build/antigravity/slp-agy-builder.md`) với đường dẫn tuyệt đối của máy hiện tại.
- Ghi các provider `slp-supervisor`, `slp-lead`, `slp-claude-builder`, `slp-claude-checker`, `slp-claude-final-reviewer`, `slp-claude-integration-reviewer`, `slp-codex-checker`, `slp-codex-advisor`, `slp-opencode-builder`, `slp-pi-builder` và override `antigravity` (`slp-agy-builder`) vào `~/.paseo/config.json`.
- Symlink 2 skill điều phối `slp-supervisor` và `slp-lead` vào `~/.claude/skills/`.
- Cài đặt agent `slp-agy-builder.md` vào `~/.gemini/config/agents/`.

---

### Bước 6: Đăng ký Dịch Vụ Chạy Nền Tự Động (`launchd` trên macOS)

Tạo file `~/Library/LaunchAgents/com.paseo.daemon.plist`:

```bash
mkdir -p ~/Library/LaunchAgents
mkdir -p "$WORKSPACE_DIR/paseo/.dev/paseo-home/models/local-speech"

cat <<EOF > ~/Library/LaunchAgents/com.paseo.daemon.plist
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
		<string>$WORKSPACE_DIR/paseo/.dev/paseo-home/models/local-speech</string>
		<key>PASEO_LOG_FILE_PATH</key>
		<string>$WORKSPACE_DIR/paseo/.dev/paseo-service-daemon.log</string>
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
		<string>$(command -v node)</string>
		<string>--import</string>
		<string>tsx</string>
		<string>scripts/dev-runner.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$WORKSPACE_DIR/paseo/.dev/paseo-service.log</string>
	<key>StandardOutPath</key>
	<string>$WORKSPACE_DIR/paseo/.dev/paseo-service.log</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>WorkingDirectory</key>
	<string>$WORKSPACE_DIR/paseo/packages/server</string>
</dict>
</plist>
EOF

# Nạp và khởi động dịch vụ nền
launchctl bootout gui/$(id -u)/com.paseo.daemon 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.paseo.daemon.plist
launchctl kickstart -k gui/$(id -u)/com.paseo.daemon
```

---

### Bước 7: Kiểm tra Hoạt Động & Conformance

1. **Mở giao diện Web UI / Desktop App**:
   - Truy cập: [http://localhost:6767](http://localhost:6767)
   - Kiểm tra phím tắt `Cmd + 9` mở **NDL-Git Tool Window**.
   - Kiểm tra nút Microphone trên thanh nhập chat để thử nghiệm đọc giọng nói tiếng Việt realtime.
2. **Kiểm tra trạng thái Daemon & Logs**:
   ```bash
   launchctl print gui/$(id -u)/com.paseo.daemon | head -n 25
   tail -f "$WORKSPACE_DIR/paseo/.dev/paseo-service.log"
   ```
3. **Chạy kiểm chứng toàn bộ SLP Providers (`slp-conformance`)**:
   ```bash
   cd "$WORKSPACE_DIR/paseo-slp"
   ./bin/slp-conformance
   ```

---

## Các Lệnh Quản Trị Nhanh Thường Dùng

| Thao tác                                        | Câu lệnh                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Khởi động lại Daemon**                        | `launchctl kickstart -k gui/$(id -u)/com.paseo.daemon`                                                                   |
| **Tắt Daemon**                                  | `launchctl bootout gui/$(id -u)/com.paseo.daemon`                                                                        |
| **Bật lại Daemon**                              | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.paseo.daemon.plist`                                         |
| **Build lại Web UI sau khi sửa `packages/app`** | `cd "$WORKSPACE_DIR/paseo/packages/app" && npx expo export --platform web && cp -R dist/* ../server/dist/server/web-ui/` |
| **Cập nhật Role/Policy của SLP**                | `cd "$WORKSPACE_DIR/paseo-slp" && ./bin/slp-build --apply`                                                               |
