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
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
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

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    jq -cn \
      --arg kind build_response \
      --arg status "$status" \
      --arg responder_session_id "$responder_session_id" \
      --arg response_file "$response_file" \
      --argjson body_bytes "$body_bytes" \
      --argjson body_chars "$body_chars" \
      --argjson body_lines "$body_lines" \
      --argjson response_bytes "$response_bytes" \
      --argjson sections "$sections" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        kind: $kind,
        ts: $ts,
        status: $status,
        responder_session_id: $responder_session_id,
        response_file: $response_file,
        body: {
          bytes: $body_bytes,
          chars: $body_chars,
          lines: $body_lines,
          estimated_tokens: (($body_chars + 3) / 4 | floor)
        },
        response: {
          bytes: $response_bytes,
          sections: $sections
        }
      }' >>"$DELEGATE_METRICS_FILE"
  ) >/dev/null 2>&1 || true
}

write_companion_markdown() {
  # JSON が protocol の正本で、Markdown は人間の監査・デバッグ用の派生物に留める。
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

cat >"$src_md"
body_bytes="$(wc -c <"$src_md" | tr -d '[:space:]')"
body_chars="$(wc -m <"$src_md" | tr -d '[:space:]')"
body_lines="$(wc -l <"$src_md" | tr -d '[:space:]')"

npx --yes md2idx "$src_md" | jq \
  --arg s "$status" \
  --arg sid "$responder_session_id" \
  '{protocol_version: 1, type: "response", status: $s, responder_session_id: $sid} + .' \
  >"$response_file"

if ! jq -e '.index != null and (.index | length) > 0 and (.sections | length) > 0' "$response_file" >/dev/null 2>&1; then
  echo "ERROR: md2idx が空の index/sections を返しました（report Markdown を確認してください）: $src_md" >&2
  exit 1
fi

write_companion_markdown "$response_file"
rm -f "$src_md"

response_bytes="$(wc -c <"$response_file" | tr -d '[:space:]')"
sections="$(jq '.sections | length' "$response_file")"
append_metrics

printf '%s\n' "$response_file"
