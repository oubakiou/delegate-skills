#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/dispatch.sh
# 各 delegate-* skill の scripts/dispatch.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）。
# 分岐は決定論的なので main agent の推論に載せず、この 1 本の呼び出しに畳む。
# Usage: dispatch.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file]
# stdout: 委譲先ラッパの stdout（response_file のパスのみ）
# exit: 委譲先ラッパの exit code をそのまま返す（2=引数エラー）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file> [run_dir] [observe_file]" >&2
  exit 2
fi

model="$1"
task_type="$2"
request_file="$3"
response_file="$4"
run_dir="${5:-${response_file%_res.json}}"
observe_file="${6:-${response_file%_res.json}_observe.json}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"

backend_script="delegate-claude.sh"
backend="$(delegate_observe_backend_for "$task_type" "$model")"
case "$backend" in
  codex) backend_script="delegate-codex.sh" ;;
  devin) backend_script="delegate-devin.sh" ;;
  cursor) backend_script="delegate-cursor.sh" ;;
  grok)
    echo "ERROR: grok backend is not supported by shared dispatch.sh; use the xresearch wrapper directly." >&2
    exit 2
    ;;
  *) backend_script="delegate-claude.sh" ;;
esac

mkdir -p "$run_dir"
if [ ! -s "$observe_file" ]; then
  delegate_observe_init "$observe_file" "$run_dir" "$task_type" "$model" "$backend" "$request_file" "$response_file" ""
fi

pid="$$"
delegate_observe_dispatch_start "$observe_file" "$run_dir" "$backend" "$pid"

wrapper_stdout=""
wrapper_status=0
if wrapper_stdout="$(bash "$script_dir/$backend_script" "$model" "$task_type" "$request_file" "$response_file" "$run_dir" "$observe_file")"; then
  wrapper_status=0
else
  wrapper_status=$?
fi

response_present=false
if [ -s "$response_file" ]; then
  response_present=true
else
  delegate_observe_response_missing "$observe_file" "$run_dir"
fi

delegate_observe_dispatch_end "$observe_file" "$run_dir" "$backend" "$pid" "$wrapper_status" "$response_present"

if [ -n "$wrapper_stdout" ]; then
  printf '%s\n' "$wrapper_stdout"
fi

exit "$wrapper_status"
