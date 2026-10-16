#!/usr/bin/env bash
set -euo pipefail

# Script đồng bộ code mới nhất từ official Paseo (upstream/main) vào repo cá nhân.
# Giữ nguyên toàn bộ code tùy biến và cập nhật tính năng mới từ upstream.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

UPSTREAM_URL="https://github.com/getpaseo/paseo.git"
UPSTREAM_BRANCH="main"

echo "=== Đồng bộ code từ official Paseo (${UPSTREAM_BRANCH}) ==="

# 1. Đảm bảo remote 'upstream' tồn tại
if ! git remote get-url upstream &>/dev/null; then
  echo ">>> Thêm remote upstream: ${UPSTREAM_URL}"
  git remote add upstream "${UPSTREAM_URL}"
else
  echo ">>> Remote upstream đã được cấu hình: $(git remote get-url upstream)"
fi

# 2. Kiểm tra working tree
if ! git diff-index --quiet HEAD --; then
  echo "⚠️  Cảnh báo: Bạn đang có thay đổi chưa commit trong working tree!"
  git status --short
  read -r -p "Bạn có muốn stash các thay đổi này trước khi sync không? (y/N): " stash_confirm
  if [[ "${stash_confirm:-}" =~ ^[Yy]$ ]]; then
    echo ">>> Stashing local changes..."
    git stash push -m "Auto-stashed before sync-upstream $(date +'%Y-%m-%d %H:%M:%S')"
  else
    echo "❌ Hủy đồng bộ. Vui lòng commit hoặc stash thay đổi trước."
    exit 1
  fi
fi

# 3. Fetch upstream mới nhất
echo ">>> Đang fetch thông tin mới nhất từ upstream/${UPSTREAM_BRANCH}..."
git fetch upstream "${UPSTREAM_BRANCH}" --tags

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEHIND_COUNT="$(git rev-list --count HEAD..upstream/"${UPSTREAM_BRANCH}")"

echo ">>> Nhánh hiện tại: ${CURRENT_BRANCH}"
echo ">>> Số lượng commit mới từ upstream/${UPSTREAM_BRANCH}: ${BEHIND_COUNT}"

if [[ "$BEHIND_COUNT" -eq 0 ]]; then
  echo "✅ Repo của bạn đã cập nhật phiên bản mới nhất từ upstream. Không cần merge!"
  exit 0
fi

# 4. Thực hiện merge
echo ">>> Đang merge upstream/${UPSTREAM_BRANCH} vào ${CURRENT_BRANCH}..."
if git merge upstream/"${UPSTREAM_BRANCH}" -m "chore(upstream): merge official paseo main ($(date +'%Y-%m-%d'))"; then
  echo "✅ Merge thành công không có xung đột!"
  read -r -p "Bạn có muốn push lên origin/${CURRENT_BRANCH} ngay bây giờ không? (y/N): " push_confirm
  if [[ "${push_confirm:-}" =~ ^[Yy]$ ]]; then
    git push origin "${CURRENT_BRANCH}"
    echo "✅ Đã push thành công lên origin/${CURRENT_BRANCH}."
  else
    echo "ℹ️  Chưa push. Bạn có thể tự kiểm tra và chạy 'git push origin ${CURRENT_BRANCH}' sau."
  fi
else
  echo "⚠️  Có xung đột (conflict) giữa code tùy biến và upstream!"
  echo "Vui lòng mở git conflict resolver hoặc dùng lệnh sau để kiểm tra:"
  echo "  git status"
  echo "Sau khi sửa xung đột, hãy add và commit hoàn tất merge."
fi
