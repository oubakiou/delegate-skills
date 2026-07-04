#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/observe-json.sh
# 各 delegate-* skill の scripts/observe-json.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

delegate_observe_backend_from_model() {
  case "$1" in
    gpt*) printf '%s' codex ;;
    swe* | devin-*) printf '%s' devin ;;
    composer* | cursor-*) printf '%s' cursor ;;
    *) printf '%s' claude ;;
  esac
}

delegate_observe_backend_for() {
  local task_type="$1"
  local model="$2"
  case "$task_type" in
    xresearch) printf '%s' grok ;;
    imagegen) printf '%s' codex ;;
    *) delegate_observe_backend_from_model "$model" ;;
  esac
}

delegate_observe_lock_file() {
  local observe_file="$1"
  local run_dir="$2"
  printf '%s/%s.lock' "$run_dir" "$(basename "${observe_file%.json}")"
}

delegate_observe_with_lock() {
  local observe_file="$1"
  local run_dir="$2"
  shift 2

  local lock_file
  lock_file="$(delegate_observe_lock_file "$observe_file" "$run_dir")"

  if command -v flock >/dev/null 2>&1; then
    exec {delegate_observe_lock_fd}>"$lock_file"
    flock "$delegate_observe_lock_fd"
    set +e
    "$@"
    local status=$?
    set -e
    flock -u "$delegate_observe_lock_fd"
    exec {delegate_observe_lock_fd}>&-
    return "$status"
  fi

  local lock_dir="${lock_file}.dir"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
  done
  set +e
  "$@"
  local status=$?
  set -e
  rmdir "$lock_dir"
  return "$status"
}

delegate_observe_init() {
  local observe_file="$1"
  local run_dir="$2"
  local task_type="$3"
  local model="$4"
  local backend="$5"
  local request_file="$6"
  local response_file="$7"
  local requester_session_id="$8"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_init_inner \
    "$observe_file" \
    "$run_dir" \
    "$task_type" \
    "$model" \
    "$backend" \
    "$request_file" \
    "$response_file" \
    "$requester_session_id"
}

delegate_observe_init_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local task_type="$3"
  local model="$4"
  local backend="$5"
  local request_file="$6"
  local response_file="$7"
  local requester_session_id="$8"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_init_XXXXX" --suffix=.json)"

  jq -cn \
    --arg ts "$now" \
    --arg task_type "$task_type" \
    --arg model "$model" \
    --arg backend "$backend" \
    --arg request_file "$request_file" \
    --arg response_file "$response_file" \
    --arg run_dir "$run_dir" \
    --arg requester_session_id "$requester_session_id" \
    '{
      schema_version: 1,
      run: {
        task_type: $task_type,
        model: $model,
        backend: $backend,
        request_file: $request_file,
        response_file: $response_file,
        run_dir: $run_dir,
        requester_session_id: $requester_session_id
      },
      state: {
        phase: "prepared",
        dispatcher_pid: null,
        started_at: null,
        ended_at: null,
        exit_code: null,
        duration_ms: null,
        response_present: false
      },
      heartbeat: {
        ts: $ts,
        backend: $backend,
        child_pid: null,
        stdout_bytes: 0,
        stderr_bytes: 0,
        last_stream_change_at: $ts
      },
      events: [
        {
          kind: "run_created",
          ts: $ts,
          run_dir: $run_dir,
          request_file: $request_file,
          response_file: $response_file
        }
      ],
      streams: {
        stdout: {bytes: 0, truncated: false, content: ""},
        stderr: {bytes: 0, truncated: false, content: ""}
      }
    }' >"$tmp"

  mv "$tmp" "$observe_file"
}

delegate_observe_event_json() {
  local observe_file="$1"
  local run_dir="$2"
  local event_json="$3"
  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_event_json_inner \
    "$observe_file" \
    "$run_dir" \
    "$event_json"
}

delegate_observe_event_json_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local event_json="$3"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_event_XXXXX" --suffix=.json)"

  jq --argjson event "$event_json" '.events += [$event]' "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
}

delegate_observe_dispatch_start() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local dispatcher_pid="$4"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local event_json
  event_json="$(jq -cn --arg ts "$now" --arg backend "$backend" --argjson dispatcher_pid "$dispatcher_pid" '{kind: "dispatch_start", ts: $ts, backend: $backend, dispatcher_pid: $dispatcher_pid}')"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_dispatch_start_inner \
    "$observe_file" \
    "$run_dir" \
    "$backend" \
    "$dispatcher_pid" \
    "$now" \
    "$event_json"
}

delegate_observe_dispatch_start_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local dispatcher_pid="$4"
  local now="$5"
  local event_json="$6"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_dispatch_start_XXXXX" --suffix=.json)"

  jq \
    --arg ts "$now" \
    --arg backend "$backend" \
    --argjson dispatcher_pid "$dispatcher_pid" \
    --argjson event "$event_json" \
    '(.state.phase = "running")
     | (.state.dispatcher_pid = $dispatcher_pid)
     | (.state.started_at = $ts)
     | (.state.ended_at = null)
     | (.state.exit_code = null)
     | (.state.duration_ms = null)
     | (.state.response_present = false)
     | (.heartbeat.ts = $ts)
     | (.heartbeat.backend = $backend)
     | (.heartbeat.child_pid = null)
     | (.heartbeat.last_stream_change_at = (.heartbeat.last_stream_change_at // $ts))
     | (.events += [$event])' \
    "$observe_file" >"$tmp"

  mv "$tmp" "$observe_file"
}

delegate_observe_heartbeat() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local child_pid="$4"
  local stdout_capture="$5"
  local stderr_capture="$6"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_heartbeat_inner \
    "$observe_file" \
    "$run_dir" \
    "$backend" \
    "$child_pid" \
    "$stdout_capture" \
    "$stderr_capture"
}

delegate_observe_heartbeat_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local child_pid="$4"
  local stdout_capture="$5"
  local stderr_capture="$6"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local stdout_bytes=0
  local stderr_bytes=0
  if [ -f "$stdout_capture" ]; then
    stdout_bytes="$(wc -c <"$stdout_capture" | tr -d '[:space:]')"
  fi
  if [ -f "$stderr_capture" ]; then
    stderr_bytes="$(wc -c <"$stderr_capture" | tr -d '[:space:]')"
  fi

  local prev_stdout_bytes prev_stderr_bytes prev_last_stream_change_at last_stream_change_at
  prev_stdout_bytes="$(jq -r '.heartbeat.stdout_bytes // 0' "$observe_file")"
  prev_stderr_bytes="$(jq -r '.heartbeat.stderr_bytes // 0' "$observe_file")"
  prev_last_stream_change_at="$(jq -r '.heartbeat.last_stream_change_at // empty' "$observe_file")"
  last_stream_change_at="$prev_last_stream_change_at"
  if [ "$stdout_bytes" -gt "$prev_stdout_bytes" ] || [ "$stderr_bytes" -gt "$prev_stderr_bytes" ]; then
    last_stream_change_at="$now"
  elif [ -z "$last_stream_change_at" ]; then
    last_stream_change_at="$now"
  fi

  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_heartbeat_XXXXX" --suffix=.json)"
  jq \
    --arg ts "$now" \
    --arg backend "$backend" \
    --argjson child_pid "$child_pid" \
    --argjson stdout_bytes "$stdout_bytes" \
    --argjson stderr_bytes "$stderr_bytes" \
    --arg last_stream_change_at "$last_stream_change_at" \
    '(.heartbeat.ts = $ts)
     | (.heartbeat.backend = $backend)
     | (.heartbeat.child_pid = $child_pid)
     | (.heartbeat.stdout_bytes = $stdout_bytes)
     | (.heartbeat.stderr_bytes = $stderr_bytes)
     | (.heartbeat.last_stream_change_at = $last_stream_change_at)' \
    "$observe_file" >"$tmp"

  mv "$tmp" "$observe_file"
}

delegate_observe_dispatch_end() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local dispatcher_pid="$4"
  local exit_code="$5"
  local response_present="$6"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_dispatch_end_inner \
    "$observe_file" \
    "$run_dir" \
    "$backend" \
    "$dispatcher_pid" \
    "$exit_code" \
    "$response_present"
}

delegate_observe_dispatch_end_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local dispatcher_pid="$4"
  local exit_code="$5"
  local response_present="$6"

  local started_at ended_at duration_ms
  started_at="$(jq -r '.state.started_at // empty' "$observe_file")"
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration_ms=0
  if [ -n "$started_at" ]; then
    local started_epoch ended_epoch
    started_epoch="$(date -u -d "$started_at" +%s)"
    ended_epoch="$(date -u -d "$ended_at" +%s)"
    duration_ms="$(( (ended_epoch - started_epoch) * 1000 ))"
  fi

  local event_json
  event_json="$(jq -cn --arg ts "$ended_at" --arg backend "$backend" --argjson dispatcher_pid "$dispatcher_pid" --argjson exit_code "$exit_code" '{kind: "dispatch_end", ts: $ts, backend: $backend, dispatcher_pid: $dispatcher_pid, exit_code: $exit_code}')"

  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_dispatch_end_XXXXX" --suffix=.json)"
  jq \
    --arg ts "$ended_at" \
    --arg backend "$backend" \
    --argjson dispatcher_pid "$dispatcher_pid" \
    --argjson exit_code "$exit_code" \
    --argjson duration_ms "$duration_ms" \
    --argjson response_present "$response_present" \
    --argjson event "$event_json" \
    '(.state.phase = (if .state.phase == "stalled" then "stalled" else "ended" end))
     | (.state.dispatcher_pid = $dispatcher_pid)
     | (.state.ended_at = $ts)
     | (.state.exit_code = $exit_code)
     | (.state.duration_ms = $duration_ms)
     | (.state.response_present = $response_present)
     | (.heartbeat.ts = $ts)
     | (.heartbeat.backend = $backend)
     | (.events += [$event])' \
    "$observe_file" >"$tmp"

  mv "$tmp" "$observe_file"
}

delegate_observe_response_missing() {
  local observe_file="$1"
  local run_dir="$2"
  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_response_missing_inner \
    "$observe_file" \
    "$run_dir"
}

delegate_observe_response_missing_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local event_json
  event_json="$(jq -cn --arg ts "$now" '{kind: "response_missing", ts: $ts}')"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_response_missing_XXXXX" --suffix=.json)"
  jq --argjson event "$event_json" '(.events += [$event])' "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
}

delegate_observe_failed_response_written() {
  local observe_file="$1"
  local run_dir="$2"
  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_failed_response_written_inner \
    "$observe_file" \
    "$run_dir"
}

delegate_observe_failed_response_written_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local event_json
  event_json="$(jq -cn --arg ts "$now" '{kind: "failed_response_written", ts: $ts}')"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_failed_response_XXXXX" --suffix=.json)"
  jq --argjson event "$event_json" '(.events += [$event])' "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
}

delegate_observe_stall_timeout() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local child_pid="$4"
  local timeout_seconds="$5"
  local idle_seconds="$6"
  local stdout_capture="$7"
  local stderr_capture="$8"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_stall_timeout_inner \
    "$observe_file" \
    "$run_dir" \
    "$backend" \
    "$child_pid" \
    "$timeout_seconds" \
    "$idle_seconds" \
    "$stdout_capture" \
    "$stderr_capture"
}

delegate_observe_stall_timeout_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local child_pid="$4"
  local timeout_seconds="$5"
  local idle_seconds="$6"
  local stdout_capture="$7"
  local stderr_capture="$8"

  local now stdout_bytes stderr_bytes event_json tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  stdout_bytes="$(delegate_observe_capture_bytes "$stdout_capture")"
  stderr_bytes="$(delegate_observe_capture_bytes "$stderr_capture")"
  event_json="$(
    jq -cn \
      --arg ts "$now" \
      --arg backend "$backend" \
      --argjson child_pid "$child_pid" \
      --argjson timeout_seconds "$timeout_seconds" \
      --argjson idle_seconds "$idle_seconds" \
      --argjson stdout_bytes "$stdout_bytes" \
      --argjson stderr_bytes "$stderr_bytes" \
      '{
        kind: "stall_timeout",
        ts: $ts,
        backend: $backend,
        child_pid: $child_pid,
        timeout_seconds: $timeout_seconds,
        idle_seconds: $idle_seconds,
        stdout_bytes: $stdout_bytes,
        stderr_bytes: $stderr_bytes
      }'
  )"

  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_stall_timeout_XXXXX" --suffix=.json)"
  jq \
    --arg ts "$now" \
    --arg backend "$backend" \
    --argjson child_pid "$child_pid" \
    --argjson stdout_bytes "$stdout_bytes" \
    --argjson stderr_bytes "$stderr_bytes" \
    --argjson event "$event_json" \
    '(.state.phase = "stalled")
     | (.heartbeat.ts = $ts)
     | (.heartbeat.backend = $backend)
     | (.heartbeat.child_pid = $child_pid)
     | (.heartbeat.stdout_bytes = $stdout_bytes)
     | (.heartbeat.stderr_bytes = $stderr_bytes)
     | (.events += [$event])' \
    "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
}

delegate_observe_write_failed_response() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local response_file="$4"
  local exit_code="$5"

  local report_file
  report_file="$(mktemp --tmpdir="$run_dir" "$(basename "$response_file" .json)_failed_XXXXX" --suffix=.md)"
  cat >"$report_file" <<EOF
# Summary
Child CLI failed or did not write a response.

# Error
See observe JSON: $observe_file
Exit code: $exit_code
EOF

  local observe_script_dir
  observe_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "$observe_script_dir/build-response.sh" failed "wrapper:${backend}:$(basename "$response_file" .json)" "$response_file" \
    <"$report_file" >/dev/null 2>&1 || return 1
  delegate_observe_failed_response_written "$observe_file" "$run_dir"
}

delegate_observe_write_companion_markdown() {
  local response_file="$1"
  (jq -r '.sections | join("\n\n")' "$response_file" >"${response_file%.json}.md") >/dev/null 2>&1 || true
}

delegate_observe_stream_cap_bytes() {
  printf '%s' "${DELEGATE_OBSERVE_STREAM_MAX_BYTES:-65536}"
}

delegate_observe_capture_bytes() {
  local capture_file="$1"
  if [ -f "$capture_file" ]; then
    wc -c <"$capture_file" | tr -d '[:space:]'
  else
    printf '%s' 0
  fi
}

delegate_observe_positive_int_or_zero() {
  case "${1:-0}" in
    '' | *[!0-9]*) printf '%s' 0 ;;
    *) printf '%s' "$1" ;;
  esac
}

delegate_observe_epoch_seconds() {
  local timestamp="$1"
  # GNU date は空文字列を「本日 0 時」として成功させるため、先に弾く
  if [ -z "$timestamp" ]; then
    printf '%s' 0
    return 0
  fi
  date -u -d "$timestamp" +%s 2>/dev/null || printf '%s' 0
}

delegate_observe_write_capture_content() {
  local capture_file="$1"
  local max_bytes="$2"
  local output_file="$3"

  if [ ! -f "$capture_file" ]; then
    : >"$output_file"
    return 0
  fi

  local bytes
  bytes="$(wc -c <"$capture_file" | tr -d '[:space:]')"
  if [ "$max_bytes" -eq 0 ] || [ "$bytes" -le "$max_bytes" ]; then
    cp "$capture_file" "$output_file"
    return 0
  fi

  tail -c "$max_bytes" "$capture_file" >"$output_file"
}

delegate_observe_import_streams() {
  local observe_file="$1"
  local run_dir="$2"
  local stdout_capture="$3"
  local stderr_capture="$4"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_import_streams_inner \
    "$observe_file" \
    "$run_dir" \
    "$stdout_capture" \
    "$stderr_capture"
}

delegate_observe_import_streams_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local stdout_capture="$3"
  local stderr_capture="$4"
  local max_bytes
  max_bytes="$(delegate_observe_stream_cap_bytes)"

  local stdout_bytes stderr_bytes stdout_truncated stderr_truncated
  stdout_bytes="$(delegate_observe_capture_bytes "$stdout_capture")"
  stderr_bytes="$(delegate_observe_capture_bytes "$stderr_capture")"
  stdout_truncated=false
  stderr_truncated=false
  if [ "$max_bytes" -ne 0 ] && [ "$stdout_bytes" -gt "$max_bytes" ]; then
    stdout_truncated=true
  fi
  if [ "$max_bytes" -ne 0 ] && [ "$stderr_bytes" -gt "$max_bytes" ]; then
    stderr_truncated=true
  fi

  local stdout_content_file stderr_content_file tmp
  stdout_content_file="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_stdout_XXXXX")"
  stderr_content_file="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_stderr_XXXXX")"
  delegate_observe_write_capture_content "$stdout_capture" "$max_bytes" "$stdout_content_file"
  delegate_observe_write_capture_content "$stderr_capture" "$max_bytes" "$stderr_content_file"

  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_streams_XXXXX" --suffix=.json)"
  jq \
    --argjson stdout_bytes "$stdout_bytes" \
    --argjson stderr_bytes "$stderr_bytes" \
    --argjson stdout_truncated "$stdout_truncated" \
    --argjson stderr_truncated "$stderr_truncated" \
    --rawfile stdout_content "$stdout_content_file" \
    --rawfile stderr_content "$stderr_content_file" \
    '(.streams.stdout.bytes = $stdout_bytes)
     | (.streams.stdout.truncated = $stdout_truncated)
     | (.streams.stdout.content = $stdout_content)
     | (.streams.stderr.bytes = $stderr_bytes)
     | (.streams.stderr.truncated = $stderr_truncated)
     | (.streams.stderr.content = $stderr_content)' \
    "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
  rm -f "$stdout_content_file" "$stderr_content_file"
}

delegate_observe_wait_with_heartbeat() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local child_pid="$4"
  local stdout_capture="$5"
  local stderr_capture="$6"

  local heartbeat_interval stall_timeout_seconds stalled child_status
  heartbeat_interval="$(delegate_observe_positive_int_or_zero "${DELEGATE_OBSERVE_HEARTBEAT_INTERVAL:-10}")"
  [ "$heartbeat_interval" -gt 0 ] || heartbeat_interval=10
  stall_timeout_seconds="$(delegate_observe_positive_int_or_zero "${DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS:-0}")"
  stalled=false

  # 子の終了検知を最大 1 秒に抑えるため 1 秒刻みで poll し、heartbeat と
  # stall 判定だけを heartbeat_interval ごとに実行する。観測系の失敗で
  # dispatch 本体を殺さないよう、observe 更新と jq 読みは fail-soft にする
  local seconds_until_heartbeat=0
  while kill -0 "$child_pid" 2>/dev/null; do
    if [ "$seconds_until_heartbeat" -le 0 ]; then
      seconds_until_heartbeat="$heartbeat_interval"
      delegate_observe_heartbeat "$observe_file" "$run_dir" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture" || true

      if [ "$stall_timeout_seconds" -gt 0 ]; then
        local last_stream_change_at last_stream_change_epoch now_epoch idle_seconds
        last_stream_change_at="$(jq -r '.heartbeat.last_stream_change_at // .state.started_at // empty' "$observe_file" 2>/dev/null || true)"
        last_stream_change_epoch="$(delegate_observe_epoch_seconds "$last_stream_change_at")"
        now_epoch="$(date -u +%s)"
        idle_seconds=0
        if [ "$last_stream_change_epoch" -gt 0 ]; then
          idle_seconds="$(( now_epoch - last_stream_change_epoch ))"
        fi
        if [ "$idle_seconds" -ge "$stall_timeout_seconds" ]; then
          stalled=true
          delegate_observe_stall_timeout "$observe_file" "$run_dir" "$backend" "$child_pid" "$stall_timeout_seconds" "$idle_seconds" "$stdout_capture" "$stderr_capture" || true
          kill "$child_pid" 2>/dev/null || true
          sleep 1
          kill -9 "$child_pid" 2>/dev/null || true
          break
        fi
      fi
    fi

    sleep 1
    seconds_until_heartbeat="$(( seconds_until_heartbeat - 1 ))"
  done

  set +e
  wait "$child_pid"
  child_status=$?
  set -e
  if [ "$stalled" = true ]; then
    child_status=124
  fi

  delegate_observe_heartbeat "$observe_file" "$run_dir" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture"
  delegate_observe_import_streams "$observe_file" "$run_dir" "$stdout_capture" "$stderr_capture"

  return "$child_status"
}
