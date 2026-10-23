# Nhiệm vụ

Cho file `.puml` / `.plantuml` / `.pu` có nút Preview và hiển thị sơ đồ trong file pane.

# Đã sửa gì

- `components/file-pane-render-mode.ts`: thêm kind `plantuml` cho các đuôi trên; helper `plantUmlFileAsMarkdown()` bọc nội dung file thành fence ` ```plantuml `.
- `file-pane/pane.tsx`: kind `plantuml` đi chung nhánh Markdown preview với source đã bọc.
- Test trong `file-pane-render-mode.test.ts`.

# Vấn đề thực sự

File pane chỉ có preview cho `.md`/`.markdown` và `.html`/`.htm`; mọi đuôi khác hiện source.

# Tại sao chọn cách này

Markdown preview đã render fence `plantuml` (zoom, xem source, nền giấy). Bọc file thành một fence là dùng lại toàn bộ, không thêm component.

# Hình dạng production

Nút Preview/Source tự xuất hiện vì `hasPreview` dựa trên `filePreviewRenderKind(path) !== null`.

# Các cách khác khả thi

1. Render trực tiếp `PlantUmlFence` trong pane với style riêng.
2. Tách nhiều `@startuml` trong một file thành nhiều fence.

# Tại sao không chọn các cách đó

1. Phải tự dựng `inheritedStyles`/`textStyle` giống markdown; trùng lặp. Hợp khi cần layout khác markdown.
2. Chưa có nhu cầu thực; file C4 thường một sơ đồ. Làm khi gặp file nhiều diagram.

# Khái niệm cốt lõi cần nắm

- Fence Markdown đóng bằng chuỗi backtick dài ≥ fence mở; dùng fence dài hơn mọi chuỗi backtick trong nội dung để không bị đóng sớm.

# Lỗi thường gặp

- `npm run lint -- <file>` báo "No files found" với một số path; truyền thư mục thay thế.
- File có nhiều `@startuml` chỉ render sơ đồ đầu tiên (giới hạn của PlantUML server với một request).

# Ví dụ nhỏ

`plantUmlFileAsMarkdown("A -> B")` → `"```plantuml\nA -> B\n```\n"`.

# Lần sau nên nghĩ thế nào

Thêm loại preview mới: tìm hàm quyết định "file nào có preview" trước, rồi xem có renderer sẵn để quy về không.
