# Nhiệm vụ
Preview sơ đồ PlantUML ngay trong tab Preview của file `.md` trên Paseo.

# Đã sửa gì
- Thêm fence `plantuml` / `puml` / `uml` vào `diagramFences` (`packages/app/src/components/markdown/fence/index.tsx`).
- `fence/plantuml/encode-source.ts`: deflate-raw (`CompressionStream`) + alphabet PlantUML → URL `https://www.plantuml.com/plantuml/svg/<encoded>`; fallback `~h` hex.
- `fence/plantuml/host.web.tsx`: tải SVG, đo kích thước gốc, hiển thị trong `ZoomableViewport` (nền trắng, nút xem source); đang stream hoặc lỗi thì hiện code block.
- `fence/plantuml/host.tsx`: native vẫn hiện code block.
- Test: `encode-source.test.ts` (round-trip tiếng Việt).

# Vấn đề thực sự
Plugin `paseo-plugin-plantuml` chỉ render ở timeline chat và một workspace panel riêng. Plugin API không có contribution point cho Markdown preview của file viewer, nên plugin không thể vẽ vào tab Preview.

# Tại sao chọn cách này
App đã có registry `diagramFences` (đang dùng cho mermaid). Thêm một entry là đủ, và áp dụng luôn cho cả chat lẫn file preview. Server render do người dùng chọn: `plantuml.com`.

# Hình dạng production
Render qua server công cộng → nội dung sơ đồ rời máy. Nếu cần giữ dữ liệu trong nội bộ, đổi `PLANTUML_SERVER_URL` sang server local (`plantuml -picoweb`) hoặc thêm RPC render trên daemon.

# Các cách khác khả thi
1. Server PlantUML local (`plantuml -picoweb:<port>` qua launchd), app trỏ tới localhost.
2. Daemon render bằng `plantuml` CLI qua RPC WebSocket mới.
3. Thêm contribution point "markdown fence renderer" vào plugin API để plugin tự đăng ký.

# Tại sao không chọn các cách đó
1. Chỉ chạy trên máy này; người dùng chọn plantuml.com cho nhanh. Hợp khi tài liệu nhạy cảm (HLD, NĐ 13/53).
2. Phải đổi protocol + server + app; hợp khi cần mobile/remote cũng thấy sơ đồ mà không lộ dữ liệu.
3. Đổi public plugin API, nặng nhất; hợp khi muốn upstream.

# Khái niệm cốt lõi cần nắm
- PlantUML URL encoding = deflate raw + base64 với bảng chữ riêng (`0-9A-Za-z-_`).
- `~h` hex không nén: tiếng Việt 2-3 byte/ký tự → URL dài gấp nhiều lần, dễ vượt giới hạn URL.

# Lỗi thường gặp
- `DecompressionStream` của Node từ chối byte đệm 0 ở cuối → test giải nén bằng `zlib.inflateRawSync`.
- `ZoomableViewport` là `flex: 1` → phải đặt `flexBasis: "auto"` + height cụ thể, nếu không box co về vài px.
- SVG PlantUML chữ đen nền trong suốt → cần nền trắng trên dark theme.

# Ví dụ nhỏ
`actor "Người dùng" as u` → `https://www.plantuml.com/plantuml/svg/SoWkIImgAStDuKfC...`

# Lần sau nên nghĩ thế nào
Trước khi sửa plugin, kiểm tra plugin API có contribution point cho chỗ cần hiển thị không. Không có thì so sánh: mở rộng API hay sửa core.
