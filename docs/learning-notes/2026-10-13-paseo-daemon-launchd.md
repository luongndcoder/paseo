# Nhiệm vụ

Cho daemon Paseo bản fork (STT tiếng Việt, `0.11.2`) chạy nền ổn định trên macOS.

# Đã sửa gì

- Dừng daemon Homebrew `0.10.3` đang giữ `~/.paseo` + port `6767`.
- Copy `.dev/launchagents/com.paseo.daemon.plist` vào `~/Library/LaunchAgents/` rồi `launchctl bootstrap gui/501 ...`.
- Gỡ LaunchAgent thử nghiệm `com.paseo.launchd-probe`.
- Không sửa code.

# Vấn đề thực sự

- Service không còn được load: lần chạy cuối bị `SIGTERM` (22:13) rồi bị `bootout`, launchd không còn biết service.
- Plist nằm trong repo (`.dev/launchagents`), không nằm trong `~/Library/LaunchAgents` → logout/reboot là mất.
- Hai daemon (Homebrew CLI `0.10.3` và fork `0.11.2`) dùng chung `PASEO_HOME=~/.paseo` và port `6767` → ai start trước thì người kia không lên được.

# Tại sao chọn cách này

Plist của Codex đã đúng (KeepAlive, RunAtLoad, PATH, env STT). Chỉ thiếu bước cài đúng chỗ và gỡ xung đột port. Smallest correct change.

# Hình dạng production

- `~/Library/LaunchAgents/com.paseo.daemon.plist`, `KeepAlive=true`, `ThrottleInterval=10`.
- Log: `.dev/paseo-service.log` (stdout/stderr launchd), `~/.paseo/daemon.log`.

# Các cách khác khả thi

1. Build `npm run build` rồi chạy `node dist/scripts/supervisor-entrypoint.js` trong plist thay vì `tsx` dev-runner.
2. `npm link`/cài global bản fork để thay CLI Homebrew, dùng `paseo daemon start` bình thường.
3. Đặt `PASEO_HOME` + port riêng cho fork (vd `6768`) để chạy song song với bản Homebrew.

# Tại sao không chọn các cách đó

1. Đang phát triển STT, cần sửa code nhanh; dist phải build lại mỗi lần. Hợp khi ổn định.
2. Đè lên bản cài chính thức, khó rollback. Hợp khi fork đã là bản dùng hằng ngày lâu dài.
3. App/web client đang trỏ `localhost:6767` với `~/.paseo` (agents, config), tách home thì mất dữ liệu cũ.

# Khái niệm cốt lõi cần nắm

- `launchctl bootstrap` = load; `bootout` = unload (mất tới khi load lại). Chỉ plist trong `~/Library/LaunchAgents` được tự load khi login.
- `KeepAlive=true` restart cả khi exit code 0.
- Daemon Paseo = supervisor + worker; pid file trong `PASEO_HOME`.

# Lỗi thường gặp

- Chạy `paseo daemon stop/start` bằng CLI Homebrew `0.10.3`: stop sẽ SIGTERM fork; start lúc fork đang restart sẽ chiếm port 6767 → fork crash-loop.
- Plist trong thư mục repo: chạy được tới reboot rồi biến mất.
- Repo trong `~/Documents` (TCC): process launchd có thể gặp `getcwd: Operation not permitted` nếu `node` chưa có quyền.

# Ví dụ nhỏ

```bash
launchctl kickstart -k gui/$(id -u)/com.paseo.daemon   # restart
launchctl bootout gui/$(id -u)/com.paseo.daemon        # tắt
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.paseo.daemon.plist  # bật
```

# Lần sau nên nghĩ thế nào

"Không chạy nền" → kiểm tra theo thứ tự: service có trong `launchctl print` không, plist có ở `~/Library/LaunchAgents` không, port/pid có bị process khác giữ không, rồi mới đọc log app.
