#!/usr/bin/env bash
set -euo pipefail

# delegate-imagegen 専用の one-shot。共通 run.sh と同一の出力契約（単一 JSON / exit code 透過 /
# dispatch 前の observe_file stderr 先出し）で、prepare-imagegen → delegate-imagegen-codex →
# read-response を 1 回の呼び出しに畳む。imagegen は専用 prepare（gpt* 限定・effort suffix
# fail-closed）を要するため、共通 run.sh の main は使わず prepare / dispatch を差し替える。
# Usage: run-imagegen.sh <parent_task_type_chain_json> <requester_session_id> [selector]
#   リクエスト本文 Markdown は stdin から渡す。selector 省略時は auto。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/run.sh"

if [ $# -lt 2 ]; then
  delegate_run_usage_error "Usage: $0 <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)"
fi

parent_chain="${1:-[]}"
requester_session_id="$2"
selector="${3:-}"

delegate_run_dispatch() {
  local model="$1"
  local request_file="$3"
  local response_file="$4"
  local run_dir="$5"
  local observe_file="$6"
  bash "$script_dir/delegate-imagegen-codex.sh" "$model" "$request_file" "$response_file" "$run_dir" "$observe_file"
}

delegate_run_one_shot imagegen "$selector" \
  bash "$script_dir/prepare-imagegen.sh" "$parent_chain" "$requester_session_id"
