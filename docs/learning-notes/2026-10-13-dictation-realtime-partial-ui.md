# Nhiệm vụ

Hiển thị text STT realtime (partial) trong lúc dictation, thay vì chỉ chèn text khi bấm xác nhận.

# Đã sửa gì

- `packages/app/src/components/dictation-controls.tsx`: `DictationOverlay` nhận prop `transcript`, hiện tối đa 2 dòng dưới volume meter; helper `tailOfTranscript()` giữ ~120 ký tự cuối, cắt theo ranh giới từ.
- `packages/app/src/composer/input/input.tsx`: dùng `partialTranscript` từ `useDictation` (trước đó bị bỏ qua dưới tên `_dictationPartialTranscript`), truyền qua `MessageInputOverlay` và thêm vào deps của `useMemo`.

# Vấn đề thực sự

Server đã emit `dictation_stream_partial`, hook `useDictation` đã lưu `partialTranscript`, chỉ có composer không render. Client đang dùng là `app.paseo.sh`, không phải app build từ fork.

# Tại sao chọn cách này

Overlay đã có style `transcriptText` (dùng cho thông báo lỗi) và props `DictationControlsProps.transcript` có sẵn. Chỉ cần nối dây, không thêm state.

# Hình dạng production

Daemon fork tự serve web UI tại `http://localhost:6767/`: `npm run build:daemon-web-ui` export app vào `packages/server/dist/server/web-ui`, plist launchd bật `PASEO_WEB_UI_ENABLED=true`. Đặt cờ ở plist, không ở `~/.paseo/config.json` (dùng chung với daemon Homebrew). Sửa UI xong phải build lại + `launchctl kickstart -k`.

# Các cách khác khả thi

1. Chèn partial trực tiếp vào textarea composer, thay dần khi có text mới.
2. Hiện partial trong một bubble riêng phía trên composer, không giới hạn số dòng.

# Tại sao không chọn các cách đó

1. Đụng tới state text của composer (draft, undo, cursor); partial bị viết lại liên tục sẽ xung đột với text người dùng gõ. Hợp khi muốn trải nghiệm giống Dictation của macOS.
2. Thêm component + layout mới; hợp khi dictation dài và cần xem toàn bộ.

# Khái niệm cốt lõi cần nắm

- Partial = kết quả decode lại toàn bộ buffer mỗi ~350ms; text có thể thay đổi giữa hai lần.
- `EXPO_PUBLIC_*` được inline lúc bundle; muốn trỏ daemon khác phải restart Metro với `-c`.

# Lỗi thường gặp

- `ellipsizeMode="head"` không chạy trên web → tự cắt bằng JS.
- Overlay cao cố định `FOOTER_HEIGHT` (75px), text quá 2 dòng sẽ tràn.
- Quên thêm biến vào deps `useMemo` → overlay không re-render.

# Ví dụ nhỏ

`tailOfTranscript("…200 ký tự…")` → `"…những chữ cuối cùng vừa nói"`.

# Lần sau nên nghĩ thế nào

"UI không hiện X" → dò theo luồng: server emit? client nhận? hook lưu? component render? Lỗi thường nằm ở mắt xích cuối.
