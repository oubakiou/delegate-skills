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
  local model_source="${9:-}"

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
    "$requester_session_id" \
    "$model_source"
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
  local model_source="${9:-}"

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
    --arg model_source "$model_source" \
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
    }
    | if $model_source == "" then . else .run.model_source = $model_source end' >"$tmp"

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

delegate_observe_usage_update() {
  local observe_file="$1"
  local run_dir="$2"
  local usage_json="$3"

  delegate_observe_with_lock \
    "$observe_file" \
    "$run_dir" \
    delegate_observe_usage_update_inner \
    "$observe_file" \
    "$run_dir" \
    "$usage_json"
}

delegate_observe_usage_update_inner() {
  local observe_file="$1"
  local run_dir="$2"
  local usage_json="$3"
  local tmp
  tmp="$(mktemp --tmpdir="$run_dir" "$(basename "${observe_file%.json}")_usage_XXXXX" --suffix=.json)"

  jq --argjson usage "$usage_json" '.usage = $usage' "$observe_file" >"$tmp"
  mv "$tmp" "$observe_file"
}

delegate_observe_usage_parse_failed() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local source="$4"
  local message="$5"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local event_json
  event_json="$(jq -cn \
    --arg ts "$now" \
    --arg backend "$backend" \
    --arg source "$source" \
    --arg message "$message" \
    '{kind: "usage_parse_failed", ts: $ts, backend: $backend, source: $source, message: $message}')"
  delegate_observe_event_json "$observe_file" "$run_dir" "$event_json"
}

delegate_observe_count_section_chars() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '%s' ''
    return 0
  fi
  jq -j '.sections // [] | join("\n\n")' "$file" 2>/dev/null | wc -m | tr -d '[:space:]'
}

delegate_observe_tokens_from_chars() {
  local chars="$1"
  if [ -z "$chars" ]; then
    printf '%s' null
    return 0
  fi
  printf '%s' "$(( (chars + 3) / 4 ))"
}

delegate_observe_estimated_usage_json() {
  local request_file="$1"
  local response_file="$2"
  local model="$3"
  local backend="$4"
  local source="$5"

  local input_chars output_chars input_tokens output_tokens total_tokens
  input_chars="$(delegate_observe_count_section_chars "$request_file")"
  output_chars="$(delegate_observe_count_section_chars "$response_file")"
  input_tokens="$(delegate_observe_tokens_from_chars "$input_chars")"
  output_tokens="$(delegate_observe_tokens_from_chars "$output_chars")"
  if [ "$input_tokens" != null ] && [ "$output_tokens" != null ]; then
    total_tokens="$(( input_tokens + output_tokens ))"
  else
    total_tokens=null
  fi

  jq -cn \
    --arg model "$model" \
    --arg backend "$backend" \
    --arg source "$source" \
    --argjson input_tokens "$input_tokens" \
    --argjson output_tokens "$output_tokens" \
    --argjson total_tokens "$total_tokens" \
    '{
      input_tokens: $input_tokens,
      output_tokens: $output_tokens,
      total_tokens: $total_tokens,
      cost_usd: null,
      measurement: "estimated",
      source: $source,
      model: $model,
      backend: $backend
    }'
}

delegate_observe_parse_usage_events() {
  local model="$1"
  local backend="$2"
  local source="$3"

  jq -R -s \
    --arg model "$model" \
    --arg backend "$backend" \
    --arg source "$source" \
    '
    def objects:
      split("\n") | map(select(length > 0) | try fromjson catch empty | select(type == "object"));
	    def usage_of:
	      .usage?
	      // .message.usage?
	      // .response.usage?
	      // .event.usage?
	      // .data.usage?
	      // .payload.info.total_token_usage?
	      // .payload.info.last_token_usage?;
	    def number_or_null($value):
	      if ($value | type) == "number" then $value else null end;
	    def sum_or_null($left; $right):
	      if (($left | type) == "number") and (($right | type) == "number") then $left + $right else null end;
	    def has_measured_value($usage):
	      ($usage.input_tokens | type) == "number"
	      or ($usage.output_tokens | type) == "number"
	      or ($usage.total_tokens | type) == "number"
	      or ($usage.cost_usd | type) == "number";
	    def token_usage($usage):
	      {
	        input_tokens: number_or_null($usage.input_tokens? // $usage.inputTokens? // $usage.prompt_tokens? // $usage.promptTokens?),
	        output_tokens: number_or_null($usage.output_tokens? // $usage.outputTokens? // $usage.completion_tokens? // $usage.completionTokens?),
        total_tokens: number_or_null($usage.total_tokens? // $usage.totalTokens?),
        cost_usd: number_or_null($usage.total_cost_usd? // $usage.cost_usd? // $usage.costUsd?)
      };
    [
      objects[]
	      | . as $event
	      | (usage_of) as $usage
	      | select($usage != null)
	      | token_usage($usage)
	        + {cost_usd: (number_or_null($event.total_cost_usd? // $event.cost_usd? // $event.costUsd?) // token_usage($usage).cost_usd)}
	      | select(has_measured_value(.))
	    ] as $items
    | if ($items | length) == 0 then empty
	      else
	        ($items[-1]) as $last
	        | {
	            input_tokens: $last.input_tokens,
	            output_tokens: $last.output_tokens,
	            total_tokens: ($last.total_tokens // sum_or_null($last.input_tokens; $last.output_tokens)),
	            cost_usd: $last.cost_usd,
	            measurement: "measured",
	            source: $source,
            model: $model,
            backend: $backend
          }
      end'
}

delegate_observe_usage_from_capture() {
  local capture_file="$1"
  local model="$2"
  local backend="$3"
  local source="$4"

	if [ ! -s "$capture_file" ]; then
	  return 1
	fi
	local usage_json
	usage_json="$(delegate_observe_parse_usage_events "$model" "$backend" "$source" <"$capture_file")"
	if [ -z "$usage_json" ]; then
	  return 1
	fi
	printf '%s\n' "$usage_json"
}

delegate_observe_usage_from_devin_export() {
  local export_file="$1"
  local model="$2"
  local backend="$3"

  if [ ! -s "$export_file" ]; then
    return 1
  fi
  jq -c \
    --arg model "$model" \
    --arg backend "$backend" \
    '
    def number_or_null($value):
      if ($value | type) == "number" then $value else null end;
    def sum_or_null($left; $right):
      if (($left | type) == "number") and (($right | type) == "number") then $left + $right else null end;
    def metrics_usage($metrics):
      {
        input_tokens: number_or_null($metrics.total_prompt_tokens? // $metrics.prompt_tokens?),
        output_tokens: number_or_null($metrics.total_completion_tokens? // $metrics.completion_tokens?),
        total_tokens: null,
        cost_usd: number_or_null($metrics.total_cost_usd? // $metrics.cost_usd?)
      };
    def summed_step_metrics:
      reduce (.steps // [])[] as $step (
        {input_tokens: 0, output_tokens: 0, cost_usd: null, found: false};
        ($step.metrics? // null) as $metrics
        | if $metrics == null then .
          else {
            input_tokens: (.input_tokens + (number_or_null($metrics.prompt_tokens?) // 0)),
            output_tokens: (.output_tokens + (number_or_null($metrics.completion_tokens?) // 0)),
            cost_usd: (.cost_usd // number_or_null($metrics.cost_usd?)),
            found: true
          }
          end
      )
      | if .found then {
          input_tokens: .input_tokens,
          output_tokens: .output_tokens,
          total_tokens: null,
          cost_usd: .cost_usd
        } else null end;
    def has_measured_value($usage):
      ($usage.input_tokens | type) == "number"
      or ($usage.output_tokens | type) == "number"
      or ($usage.total_tokens | type) == "number"
      or ($usage.cost_usd | type) == "number";
    (if .final_metrics? then metrics_usage(.final_metrics) else summed_step_metrics end) as $usage
    | select($usage != null and has_measured_value($usage))
    | {
        input_tokens: $usage.input_tokens,
        output_tokens: $usage.output_tokens,
        total_tokens: ($usage.total_tokens // sum_or_null($usage.input_tokens; $usage.output_tokens)),
        cost_usd: $usage.cost_usd,
        measurement: "measured",
        source: "devin_atif_export",
        model: $model,
        backend: $backend
      }' "$export_file"
}

delegate_observe_usage_from_codex_sessions() {
  local codex_home="$1"
  local model="$2"
  local backend="$3"
  local sessions_dir="$codex_home/sessions"

  if [ ! -d "$sessions_dir" ]; then
    return 1
  fi
  local usage_json
  usage_json="$(
    find "$sessions_dir" -type f -name '*.jsonl' -print0 2>/dev/null \
      | xargs -0 cat 2>/dev/null \
      | delegate_observe_parse_usage_events "$model" "$backend" codex_session_jsonl
  )"
  if [ -z "$usage_json" ]; then
    return 1
  fi
  printf '%s\n' "$usage_json"
}

delegate_observe_record_usage() {
  local observe_file="$1"
  local run_dir="$2"
  local backend="$3"
  local model="$4"
  local request_file="$5"
  local response_file="$6"
  local source="$7"
  local measured_json="${8:-}"

  local usage_json
  if [ -n "$measured_json" ]; then
    usage_json="$measured_json"
  else
    delegate_observe_usage_parse_failed "$observe_file" "$run_dir" "$backend" "$source" "measured usage was not available" || true
    usage_json="$(delegate_observe_estimated_usage_json "$request_file" "$response_file" "$model" "$backend" chars_4)"
  fi
  delegate_observe_usage_update "$observe_file" "$run_dir" "$usage_json"
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
