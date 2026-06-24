#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/build-response.sh
# 各 delegate-* skill の scripts/build-response.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# レスポンスファイル生成（protocol v1）。worker 側で report Markdown から生成する。
# Usage: build-response.sh <status> <responder_session_id> <response_file>
#   レポート本文 Markdown は stdin から渡す。response_file は main が事前確保したパス。
#   status: completed | partial | failed | needs_input
#   見出しは Summary / Changed files / Commands / Verification / Findings / Blockers / Error。
# stdout: response_file のパス（本文は親 context に入れない）
# exit: 2=引数/ status 不正 / 3=前提条件(jq)不足 / 1=md2idx 失敗・空 index/sections

if [ $# -lt 3 ]; then
  echo "Usage: $0 <status> <responder_session_id> <response_file>  (report markdown on stdin)" >&2
  exit 2
fi

status="$1"
responder_session_id="$2"
response_file="$3"

case "$status" in
  completed | partial | failed | needs_input) ;;
  *)
    echo "ERROR: status は completed|partial|failed|needs_input のいずれか: $status" >&2
    exit 2
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

work_dir="$(dirname "$response_file")"
mkdir -p "$work_dir"
src_md="$(mktemp --tmpdir="$work_dir" "$(basename "$response_file" .json)_repsrc_XXXXX" --suffix=.md)"

cat >"$src_md"

npx --yes md2idx "$src_md" | jq \
  --arg s "$status" \
  --arg sid "$responder_session_id" \
  '{protocol_version: 1, type: "response", status: $s, responder_session_id: $sid} + .' \
  >"$response_file"

if ! jq -e '.index != null and (.index | length) > 0 and (.sections | length) > 0' "$response_file" >/dev/null 2>&1; then
  echo "ERROR: md2idx が空の index/sections を返しました（report Markdown を確認してください）: $src_md" >&2
  exit 1
fi

rm -f "$src_md"

printf '%s\n' "$response_file"
