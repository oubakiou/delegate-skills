#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/build-request.sh
# 各 delegate-* skill の scripts/build-request.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# リクエストファイル生成（protocol v1）
# 命名・md2idx 変換・envelope 付与・response_file 導出を一括で行い、手組みの jq を排する。
# Usage: build-request.sh <task_type> <model> <task_type_chain_json> <requester_session_id>
#   リクエスト本文 Markdown は stdin から渡す（中間ファイルはスクリプトが WORK_DIR 内で管理）。
#   見出しは Objective / Scope / Context / Acceptance criteria / Verification / Constraints。
# stdout: {"request_file": "...", "response_file": "..."}（JSON）
# 置き場: DELEGATE_WORK_DIR（無ければ TMPDIR、無ければ /tmp）
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=md2idx 失敗・空 index/sections

if [ $# -lt 4 ]; then
  echo "Usage: $0 <task_type> <model> <task_type_chain_json> <requester_session_id>  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="$1"
model="$2"
task_type_chain="$3"
requester_session_id="$4"

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

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    jq -cn \
      --arg kind build_request \
      --arg task_type "$task_type" \
      --arg model "$model" \
      --arg requester_session_id "$requester_session_id" \
      --arg request_file "$request_file" \
      --arg response_file "$response_file" \
      --argjson body_bytes "$body_bytes" \
      --argjson body_chars "$body_chars" \
      --argjson body_lines "$body_lines" \
      --argjson request_bytes "$request_bytes" \
      --argjson sections "$sections" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        kind: $kind,
        ts: $ts,
        task_type: $task_type,
        model: $model,
        requester_session_id: $requester_session_id,
        request_file: $request_file,
        response_file: $response_file,
        body: {
          bytes: $body_bytes,
          chars: $body_chars,
          lines: $body_lines,
          estimated_tokens: (($body_chars + 3) / 4 | floor)
        },
        request: {
          bytes: $request_bytes,
          sections: $sections
        }
      }' >>"$DELEGATE_METRICS_FILE"
  ) >/dev/null 2>&1 || true
}

write_companion_markdown() {
  # JSON が protocol の正本で、Markdown は人間の監査・デバッグ用の派生物に留める。
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

ts="$(date +%Y%m%d_%H%M%S)"
request_tmp="$(mktemp --tmpdir="$work_dir" "delegate_${task_type}_${ts}_req_XXXXX" --suffix=.json)"
# mktemp は suffix 併用時に末尾 X が必要なので、一旦 valid な一時名で作ってから desired basename に rename する。
request_token="$(basename "$request_tmp")"
request_token="${request_token#delegate_${task_type}_${ts}_req_}"
request_token="${request_token%.json}"
request_file="${work_dir}/delegate_${task_type}_${ts}_${request_token}_req.json"
mv "$request_tmp" "$request_file"
# 乱数トークンを共有して response を導出（末尾の `_req` / `_res` だけを差し替える）
response_file="${request_file%_req.json}_res.json"
src_md="$(mktemp --tmpdir="$work_dir" "delegate_${task_type}_${ts}_reqsrc_XXXXX" --suffix=.md)"

cat >"$src_md"
body_bytes="$(wc -c <"$src_md" | tr -d '[:space:]')"
body_chars="$(wc -m <"$src_md" | tr -d '[:space:]')"
body_lines="$(wc -l <"$src_md" | tr -d '[:space:]')"

npx --yes md2idx "$src_md" | jq \
  --argjson chain "$task_type_chain" \
  --arg tt "$task_type" \
  --arg model "$model" \
  --arg sid "$requester_session_id" \
  '{protocol_version: 1, type: "request", task_type: $tt, model: $model, task_type_chain: $chain, requester_session_id: $sid} + .' \
  >"$request_file"

if ! jq -e '.index != null and (.index | length) > 0 and (.sections | length) > 0' "$request_file" >/dev/null 2>&1; then
  echo "ERROR: md2idx が空の index/sections を返しました（入力 Markdown を確認してください）: $src_md" >&2
  exit 1
fi

write_companion_markdown "$request_file"
rm -f "$src_md"

request_bytes="$(wc -c <"$request_file" | tr -d '[:space:]')"
sections="$(jq '.sections | length' "$request_file")"
append_metrics

jq -n --arg req "$request_file" --arg res "$response_file" '{request_file: $req, response_file: $res}'
