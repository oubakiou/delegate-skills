#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/build-request.sh
# 各 delegate-* skill の scripts/build-request.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# リクエストファイル生成（protocol v1）
# 命名・md2idx 変換・envelope 付与・response_file 導出を一括で行い、手組みの jq を排する。
# Usage: build-request.sh <task_type> <task_type_chain_json> <requester_session_id>
#   リクエスト本文 Markdown は stdin から渡す（中間ファイルはスクリプトが WORK_DIR 内で管理）。
#   見出しは Objective / Scope / Context / Acceptance criteria / Verification / Constraints。
# stdout: {"request_file": "...", "response_file": "..."}（JSON）
# 置き場: DELEGATE_WORK_DIR（無ければ TMPDIR、無ければ /tmp）
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=md2idx 失敗・空 index/sections

if [ $# -lt 3 ]; then
  echo "Usage: $0 <task_type> <task_type_chain_json> <requester_session_id>  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="$1"
task_type_chain="$2"
requester_session_id="$3"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

if ! printf '%s' "$task_type_chain" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: task_type_chain が JSON 配列ではありません: $task_type_chain" >&2
  exit 2
fi

work_dir="${DELEGATE_WORK_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$work_dir"
work_dir="$(cd "$work_dir" && pwd)"

ts="$(date +%Y%m%d_%H%M%S)"
request_file="$(mktemp --tmpdir="$work_dir" "delegate_${task_type}_${ts}_request_XXXXX" --suffix=.json)"
# 乱数トークンを共有して response を導出（_request_ は task_type に含まれないため一意に置換できる）
response_file="${request_file/_request_/_response_}"
src_md="$(mktemp --tmpdir="$work_dir" "delegate_${task_type}_${ts}_reqsrc_XXXXX" --suffix=.md)"

cat >"$src_md"

npx --yes md2idx "$src_md" | jq \
  --argjson chain "$task_type_chain" \
  --arg tt "$task_type" \
  --arg sid "$requester_session_id" \
  '{protocol_version: 1, type: "request", task_type: $tt, task_type_chain: $chain, requester_session_id: $sid} + .' \
  >"$request_file"

if ! jq -e '.index != null and (.index | length) > 0 and (.sections | length) > 0' "$request_file" >/dev/null 2>&1; then
  echo "ERROR: md2idx が空の index/sections を返しました（入力 Markdown を確認してください）: $src_md" >&2
  exit 1
fi

rm -f "$src_md"

jq -n --arg req "$request_file" --arg res "$response_file" '{request_file: $req, response_file: $res}'
