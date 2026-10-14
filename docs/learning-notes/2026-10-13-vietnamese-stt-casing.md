# Nhiệm vụ
Sửa STT tiếng Việt: text ra toàn chữ HOA, không thấy text realtime khi dictation.

# Đã sửa gì
- `SherpaOfflineRecognizerEngine` thêm `uppercaseVocabulary` + `textLocale`, method `normalizeText()` (lowercase theo locale `vi`).
- `worker-process.ts` bật cờ khi dùng model `zipformer-vi`.
- `sherpa-parakeet-stt.ts`, `sherpa-parakeet-realtime-session.ts` gọi `normalizeText()`; session realtime viết hoa chữ đầu của segment đầu tiên.
- Realtime: chưa sửa (thuộc UI app, cần quyết định).

# Vấn đề thực sự
- `tokens.txt` của `sherpa-onnx-zipformer-vi-30M-int8` toàn chữ HOA (`▁KHÔNG`, `▁MỘT`): model train trên transcript upper-case.
- Server đã emit `dictation_stream_partial` mỗi ~350ms, nhưng composer upstream bỏ qua (`partialTranscript: _dictationPartialTranscript`). Client đang dùng là `app.paseo.sh`, không phải app build từ fork.

# Tại sao chọn cách này
Casing là đặc tính của model, nên đặt cờ ở engine config, cạnh đường dẫn model. Engine tiếng Anh (parakeet) không đổi hành vi.

# Hình dạng production
Cờ đi theo model; nếu sau này thêm model khác train upper-case thì chỉ cần bật cờ.

# Các cách khác khả thi
1. Lowercase ở `dictation-stream-manager.ts` khi language = `vi`.
2. Viết lại `tokens.txt` sang lowercase lúc download model.
3. Thêm punctuation/truecasing model (sherpa có punctuation model) để có dấu câu + viết hoa tên riêng.

# Tại sao không chọn các cách đó
1. Trộn logic model vào luồng dictation chung; voice mode không được hưởng.
2. Sửa file model đã verify SHA-256, dễ lệch khi re-download.
3. Đúng hướng lâu dài nhưng thêm model + latency; làm khi cần dấu câu.

# Khái niệm cốt lõi cần nắm
- Offline recognizer không có partial thật; "realtime" ở đây là decode lại toàn bộ buffer mỗi 350ms.
- `toLocaleLowerCase("vi")` giữ dấu tiếng Việt đúng.

# Lỗi thường gặp
- Viết hoa chữ đầu mỗi segment: segment bị cắt theo `autoCommitBytes`, giữa câu sẽ có chữ hoa lạc.
- Sửa UI trong fork nhưng vẫn mở `app.paseo.sh`: không thấy thay đổi.

# Ví dụ nhỏ
`"KHÔNG ĐƯỢC ĐẤY"` → `"Không được đấy"`.

# Lần sau nên nghĩ thế nào
Output STT sai format → mở `tokens.txt` trước. UI không hiển thị → kiểm tra server có emit không, rồi client có dùng không, rồi client đang chạy là bản nào.
