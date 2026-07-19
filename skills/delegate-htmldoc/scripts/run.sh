#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/run.sh
# 各 delegate-* skill の scripts/run.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# 通常 run の親側フロー（prepare → dispatch → read-response）を 1 回の呼び出しに畳む one-shot。
# 個別スクリプトを別々の Bash 往復で呼ぶと親 LLM の推論ターンが挟まり委譲オーバーヘッドを
# 押し上げるため、happy path をこの 1 本に畳む。resumable / followup / background 監視などの
# 高度なフローは従来どおり個別スクリプト（prepare.sh / dispatch.sh / read-response.sh）を使う。
#
# Usage: run.sh <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [selector]
#   リクエスト本文 Markdown は stdin から渡す。
#   第 6 位置引数は read-response.sh へ渡す selector（prepare.sh の第 6 位置引数 session_mode
#   とは意味が異なる）。省略時の既定は task 種別で切り、review は decision、他は auto。
# stdout: 成功・失敗とも単一 JSON
#   {"exit_code":0,"status":"completed","content":"...","content_truncated":false,
#    "response_file":"...","observe_file":"...","run_dir":"..."}
#   content は DELEGATE_RUN_CONTENT_MAX バイト（既定 16384、0 で無制限）で切り詰め、
#   超過時は content_truncated: true。全文は response_file を参照する。
# stderr: dispatch 前に "observe_file: <path>" を先出しする（signal・外部 timeout による
#   強制終了で構造化 stdout を返せない場合の復旧経路。one-shot 保証の対象外）。
# exit: 内部スクリプトの exit code を透過する（prepare 1=md2idx 失敗 / 2=引数エラー /
#   3=前提条件不足 / 4=委譲サイクル / 6=effort 指定不正、dispatch 失敗、read-response 失敗）。
#   session_mode を渡さないため prepare の exit 5（follow-up 検証失敗）は発生しない。

DELEGATE_RUN_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

delegate_run_content_max() {
  case "${DELEGATE_RUN_CONTENT_MAX:-16384}" in
    '' | *[!0-9]*) printf '%s' 16384 ;;
    *) printf '%s' "${DELEGATE_RUN_CONTENT_MAX:-16384}" ;;
  esac
}

# trap EXIT は関数の local が消えた後に走るためグローバルで持つ
DELEGATE_RUN_SCRATCH=""

delegate_run_cleanup() {
  if [ -n "${DELEGATE_RUN_SCRATCH:-}" ]; then
    rm -rf "$DELEGATE_RUN_SCRATCH"
  fi
}

delegate_run_default_selector() {
  case "$1" in
    review) printf '%s' decision ;;
    *) printf '%s' auto ;;
  esac
}

# 成功・失敗を問わず同一 schema の JSON を stdout へ 1 回だけ出す。
# content の切り詰めは jq 側で行う: head -c のバイト切断は UTF-8 文字の途中で切れ、
# jq が不正バイトを 3 byte の置換文字 U+FFFD に変えて上限超過と本文破損を起こすため、
# 文字境界を保ったまま上限バイト以下の最長 prefix を二分探索で取る
delegate_run_emit() {
  local exit_code="$1"
  local status="$2"
  local content_file="$3"
  local response_file="$4"
  local observe_file="$5"
  local run_dir="$6"

  local content_max
  content_max="$(delegate_run_content_max)"
  [ -f "$content_file" ] || : >"$content_file"

  jq -n \
    --argjson exit_code "$exit_code" \
    --arg status "$status" \
    --rawfile content "$content_file" \
    --argjson content_max "$content_max" \
    --arg response_file "$response_file" \
    --arg observe_file "$observe_file" \
    --arg run_dir "$run_dir" \
    '
    def clip_bytes($max):
      . as $text
      | [0, ($text | length)]
      | until(.[1] - .[0] <= 1;
          ((((.[0] + .[1]) / 2) | floor)) as $mid
          | if ($text[:$mid] | utf8bytelength) <= $max then [$mid, .[1]] else [.[0], $mid] end)
      | $text[:.[0]];
    ($content_max > 0 and ($content | utf8bytelength) > $content_max) as $truncated
    | {
        exit_code: $exit_code,
        status: $status,
        content: (if $truncated then ($content | clip_bytes($content_max)) else $content end),
        content_truncated: $truncated,
        response_file: (if $response_file == "" then null else $response_file end),
        observe_file: (if $observe_file == "" then null else $observe_file end),
        run_dir: (if $run_dir == "" then null else $run_dir end)
      }'
}

# 引数エラーでも one-shot 契約（単一 JSON stdout + exit 2）を崩さない
delegate_run_usage_error() {
  local usage_text="$1"
  printf '%s\n' "$usage_text" >&2
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/delegate-run-usage.XXXXXX")"
  printf '%s\n' "$usage_text" >"$tmp"
  delegate_run_emit 2 failed "$tmp" "" "" ""
  rm -f "$tmp"
  exit 2
}

# dispatch は共通 dispatch.sh。共通 dispatch を通れない専用 skill の run-*.sh は
# source 後にこの関数を上書きする（imagegen は専用 prepare / wrapper、x-research は
# dispatch.sh が grok を明示拒否するため）
delegate_run_dispatch() {
  local model="$1"
  local task_type="$2"
  local request_file="$3"
  local response_file="$4"
  local run_dir="$5"
  local observe_file="$6"
  bash "$DELEGATE_RUN_SCRIPT_DIR/dispatch.sh" "$model" "$task_type" "$request_file" "$response_file" "$run_dir" "$observe_file"
}

delegate_run_one_shot() {
  local task_type="$1"
  local selector="$2"
  shift 2
  # 残りの "$@" は prepare コマンド（stdin の本文をそのまま消費し、prepare JSON を stdout へ返す）

  DELEGATE_RUN_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/delegate-run.XXXXXX")"
  trap delegate_run_cleanup EXIT
  local scratch="$DELEGATE_RUN_SCRATCH"

  [ -n "$selector" ] || selector="$(delegate_run_default_selector "$task_type")"

  local prepare_out prepare_status
  if prepare_out="$("$@" 2>"$scratch/prepare.stderr")"; then
    prepare_status=0
  else
    prepare_status=$?
  fi
  if [ "$prepare_status" -ne 0 ]; then
    delegate_run_emit "$prepare_status" failed "$scratch/prepare.stderr" "" "" ""
    exit "$prepare_status"
  fi

  local model request_file response_file run_dir observe_file
  model="$(jq -r '.model' <<<"$prepare_out")"
  request_file="$(jq -r '.request_file' <<<"$prepare_out")"
  response_file="$(jq -r '.response_file' <<<"$prepare_out")"
  run_dir="$(jq -r '.run_dir' <<<"$prepare_out")"
  observe_file="$(jq -r '.observe_file' <<<"$prepare_out")"

  printf 'observe_file: %s\n' "$observe_file" >&2

  local dispatch_status
  if delegate_run_dispatch "$model" "$task_type" "$request_file" "$response_file" "$run_dir" "$observe_file" \
    >"$scratch/dispatch.stdout" 2>"$scratch/dispatch.stderr"; then
    dispatch_status=0
  else
    dispatch_status=$?
  fi

  local status=failed read_status=0
  : >"$scratch/content"
  if [ -s "$response_file" ]; then
    status="$(jq -r 'if (.status | type) == "string" then .status else "failed" end' "$response_file" 2>/dev/null || printf 'failed')"
    if bash "$DELEGATE_RUN_SCRIPT_DIR/read-response.sh" "$response_file" "$selector" \
      >"$scratch/content" 2>"$scratch/read.stderr"; then
      read_status=0
    else
      read_status=$?
      status=failed
      cat "$scratch/read.stderr" >>"$scratch/content" 2>/dev/null || true
    fi
  else
    # failed response の生成すら無い異常系: dispatch stderr を上限付きで親へ返す
    cat "$scratch/dispatch.stderr" >"$scratch/content" 2>/dev/null || true
  fi

  local exit_code="$dispatch_status"
  if [ "$exit_code" -eq 0 ]; then
    exit_code="$read_status"
  fi
  delegate_run_emit "$exit_code" "$status" "$scratch/content" "$response_file" "$observe_file" "$run_dir"
  exit "$exit_code"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ $# -lt 5 ]; then
    delegate_run_usage_error "Usage: $0 <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)"
  fi
  run_task_type="$1"
  run_type_env="$2"
  run_default_model="$3"
  run_parent_chain="${4:-[]}"
  run_requester="$5"
  run_selector="${6:-}"
  delegate_run_one_shot "$run_task_type" "$run_selector" \
    bash "$DELEGATE_RUN_SCRIPT_DIR/prepare.sh" "$run_task_type" "$run_type_env" "$run_default_model" "$run_parent_chain" "$run_requester"
fi
