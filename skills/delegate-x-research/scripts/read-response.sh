#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/read-response.sh
# 各 delegate-* skill の scripts/read-response.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# レスポンスファイルの段階読み取り（protocol v1）。main 側で status → index → 必要 section の順に最安で読む。
# Usage: read-response.sh <response_file> [selector]
#   selector:
#     (省略) | status : .status を出力（既定・最安ゲート）
#     auto            : サイズゲート。小さい（既定 10KB 未満）なら status + 全 section を 1 回で丸読み、
#                       大きいなら status + index + Summary section のみ返し、他は <N> の段階読みへ誘導する
#     index           : 目次（.index）
#     meta            : protocol_version/type/status/responder_session_id を JSON で出力
#     all             : 全 section を区切り付きで出力
#     <整数N>         : .sections[N] を出力
#   閾値は DELEGATE_RESPONSE_INLINE_MAX（バイト, 既定 10240）で上書き可。
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=ファイル不在・selector 不正・範囲外

if [ $# -lt 1 ]; then
  echo "Usage: $0 <response_file> [status|auto|index|meta|all|<N>]" >&2
  exit 2
fi

response_file="$1"
selector="${2:-status}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"

read_response_start_ms="$(delegate_observe_monotonic_ms)"

if [ ! -f "$response_file" ]; then
  echo "ERROR: response_file が見つかりません: $response_file" >&2
  exit 1
fi

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    response_bytes="$(wc -c <"$response_file" | tr -d '[:space:]')"
    sections="$(jq '.sections | length' "$response_file")"
    status_value="$(jq -r '.status' "$response_file")"
    selected_bytes="$(printf '%s\n' "$output" | wc -c | tr -d '[:space:]')"
    selected_chars="$(printf '%s\n' "$output" | wc -m | tr -d '[:space:]')"
    selected_lines="$(printf '%s\n' "$output" | wc -l | tr -d '[:space:]')"
    duration_ms="$(delegate_observe_elapsed_ms "$read_response_start_ms")"
    jq -cn \
      --arg kind read_response \
      --arg duration_ms "$duration_ms" \
      --arg selector "$selector" \
      --arg status "$status_value" \
      --arg response_file "$response_file" \
      --argjson response_bytes "$response_bytes" \
      --argjson sections "$sections" \
      --argjson selected_bytes "$selected_bytes" \
      --argjson selected_chars "$selected_chars" \
      --argjson selected_lines "$selected_lines" \
      --argjson inline "$inline" \
      --argjson threshold "$threshold" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        kind: $kind,
        ts: $ts,
        duration_ms: (if $duration_ms == "" then null else ($duration_ms | tonumber) end),
        selector: $selector,
        status: $status,
        response_file: $response_file,
        inline: $inline,
        threshold: $threshold,
        response: {
          bytes: $response_bytes,
          sections: $sections,
          estimated_tokens: (($response_bytes + 3) / 4 | floor)
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
  status)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r '.status' "$response_file"
      exit 0
    fi
    inline=false
    threshold=0
    output="$(jq -r '.status' "$response_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  auto)
    # 小さい response は段階読み（status→index→section の jq 複数往復）より丸読みが安い。
    # 大きい response は main に全 section を流し込まず、status + index + Summary だけ返して
    # 残りをオンデマンド（<N>）に回すことで main（高価なモデル）の入力を抑える。
    auto_large_jq='(.sections | to_entries | map(select(.value | split("\n")[0] | test("^#+\\s*Summary\\s*$"))) | first) as $s
      | "status: \(.status)\n===== index =====\n\(.index)\n"
        + (if $s == null
           then "large response: \(.sections | length) sections（Summary section 無し。必要 section のみ <N> で取得）"
           else "===== section[\($s.key)] (Summary) =====\n\($s.value)\n（他 section は必要分のみ <N> で取得）"
           end)'
    threshold="${DELEGATE_RESPONSE_INLINE_MAX:-10240}"
    size="$(wc -c <"$response_file" | tr -d '[:space:]')"
    if [ "$size" -lt "$threshold" ]; then
      if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
        jq -r '"status: \(.status)\n" + (.sections | to_entries | map("===== section[\(.key)] =====\n\(.value)") | join("\n"))' "$response_file"
        exit 0
      fi
      inline=true
      output="$(jq -r '"status: \(.status)\n" + (.sections | to_entries | map("===== section[\(.key)] =====\n\(.value)") | join("\n"))' "$response_file")"
      append_metrics
      printf '%s\n' "$output"
    else
      if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
        jq -r "$auto_large_jq" "$response_file"
        exit 0
      fi
      inline=false
      output="$(jq -r "$auto_large_jq" "$response_file")"
      append_metrics
      printf '%s\n' "$output"
    fi
    ;;
  index)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r '.index' "$response_file"
      exit 0
    fi
    inline=false
    threshold=0
    output="$(jq -r '.index' "$response_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  meta)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq '{protocol_version, type, status, responder_session_id}' "$response_file"
      exit 0
    fi
    inline=false
    threshold=0
    output="$(jq '{protocol_version, type, status, responder_session_id}' "$response_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  all)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$response_file"
      exit 0
    fi
    inline=true
    threshold=0
    output="$(jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$response_file")"
    append_metrics
    printf '%s\n' "$output"
    ;;
  *[!0-9]*)
    echo "ERROR: 不明な selector: $selector（status|index|meta|all|<整数N> のいずれか）" >&2
    exit 1
    ;;
  *)
    if [ -z "${DELEGATE_METRICS_FILE:-}" ]; then
      jq -r --argjson n "$selector" \
        'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
        "$response_file"
      exit 0
    fi
    inline=true
    threshold=0
    output="$(
      jq -r --argjson n "$selector" \
        'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
        "$response_file"
    )"
    append_metrics
    printf '%s\n' "$output"
    ;;
esac
