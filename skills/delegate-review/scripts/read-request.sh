#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/read-request.sh
# 各 delegate-* skill の scripts/read-request.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# リクエストファイルの段階読み取り（protocol v1）。worker 側で index → 必要 section の順に読む。
# Usage: read-request.sh <request_file> [selector]
#   selector:
#     (省略) | index : 目次（.index）を出力（既定）
#     meta            : protocol_version/type/task_type/task_type_chain/requester_session_id を JSON で出力
#     all             : 全 section を区切り付きで出力
#     <整数N>         : .sections[N] を出力
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=ファイル不在・selector 不正・範囲外

if [ $# -lt 1 ]; then
  echo "Usage: $0 <request_file> [index|meta|all|<N>]" >&2
  exit 2
fi

request_file="$1"
selector="${2:-index}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

if [ ! -f "$request_file" ]; then
  echo "ERROR: request_file が見つかりません: $request_file" >&2
  exit 1
fi

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    request_bytes="$(wc -c <"$request_file" | tr -d '[:space:]')"
    sections="$(jq '.sections | length' "$request_file")"
    task_type="$(jq -r '.task_type' "$request_file")"
    selected_bytes="$(printf '%s\n' "$output" | wc -c | tr -d '[:space:]')"
    selected_chars="$(printf '%s\n' "$output" | wc -m | tr -d '[:space:]')"
    selected_lines="$(printf '%s\n' "$output" | wc -l | tr -d '[:space:]')"
    jq -cn \
      --arg kind read_request \
      --arg selector "$selector" \
      --arg task_type "$task_type" \
      --arg request_file "$request_file" \
      --argjson request_bytes "$request_bytes" \
      --argjson sections "$sections" \
      --argjson selected_bytes "$selected_bytes" \
      --argjson selected_chars "$selected_chars" \
      --argjson selected_lines "$selected_lines" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        kind: $kind,
        ts: $ts,
        selector: $selector,
        task_type: $task_type,
        request_file: $request_file,
        request: {
          bytes: $request_bytes,
          sections: $sections
        },
        selected: {
          bytes: $selected_bytes,
          chars: $selected_chars,
          lines: $selected_lines,
          estimated_tokens: (($selected_chars + 3) / 4 | floor)
        }
      }' >>"$DELEGATE_METRICS_FILE"
  ) >/dev/null 2>&1 || true
}

case "$selector" in
  index)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r '.index' "$request_file"
      exit 0
    fi
    output="$(jq -r '.index' "$request_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  meta)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq '{protocol_version, type, task_type, task_type_chain, requester_session_id}' "$request_file"
      exit 0
    fi
    output="$(jq '{protocol_version, type, task_type, task_type_chain, requester_session_id}' "$request_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  all)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$request_file"
      exit 0
    fi
    output="$(jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$request_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  *[!0-9]*)
    echo "ERROR: 不明な selector: $selector（index|meta|all|<整数N> のいずれか）" >&2
    exit 1
    ;;
  *)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r --argjson n "$selector" \
        'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
        "$request_file"
      exit 0
    fi
    output="$(
      jq -r --argjson n "$selector" \
        'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
        "$request_file"
    )"
    append_metrics
    printf '%s\n' "$output"
    ;;
esac
