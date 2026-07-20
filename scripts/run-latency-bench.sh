#!/usr/bin/env bash
set -euo pipefail

# レイテンシ反復ベンチ（docs/feature/typescript-migration.md §6）。
# fixtures/metrics の baseline は duration 系を意図的に含まないため、TS 移行前後の
# レイテンシ回帰はこのベンチで別途比較する。warm-up 1 回 + 本計測 N 回（既定 10）で
# 3 fixture を通し、prepare / read_response / dispatch の duration_ms p50
# （nearest-rank、summarize-metrics.ts と同方式）を JSON で stdout へ出す。
# dispatch は実 CLI 抜きの fake claude 経由なので、比較できるのは
# orchestration スクリプト自体のオーバーヘッドのみ（モデル実行時間は含まない）。
# Usage: run-latency-bench.sh [iterations]

iterations="${1:-10}"
case "$iterations" in
  '' | *[!0-9]*)
    echo "Usage: $0 [iterations]" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$repo_root/fixtures/metrics"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/delegate-latency-bench.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT
fixtures=(scriptable-chore read-heavy-chore mixed-chore)

fake_bin="$work_root/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/claude" <<'FAKE_EOF'
#!/usr/bin/env bash
printf '%s\n' '{"type":"system","subtype":"init"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}'
printf '%s\n' '{"type":"result","num_turns":2,"usage":{"input_tokens":100,"output_tokens":10}}'
exit 0
FAKE_EOF
chmod +x "$fake_bin/claude"

run_fixture_pass() {
  local metrics_file="$1"
  local pass_dir="$2"
  local name work_dir out request_file response_file run_dir observe_file

  for name in "${fixtures[@]}"; do
    work_dir="$pass_dir/$name"
    mkdir -p "$work_dir"

    out="$(
      DELEGATE_WORK_DIR="$work_dir" \
        DELEGATE_METRICS_FILE="$metrics_file" \
        bash "$repo_root/shared/prepare.sh" chore DELEGATE_CHORE_MODEL haiku '[]' "bench-$name" \
        <"$fixture_root/$name/request.md"
    )"
    request_file="$(printf '%s' "$out" | jq -r .request_file)"
    response_file="$(printf '%s' "$out" | jq -r .response_file)"
    run_dir="$(printf '%s' "$out" | jq -r .run_dir)"
    observe_file="$(printf '%s' "$out" | jq -r .observe_file)"

    DELEGATE_METRICS_FILE="$metrics_file" \
      bash "$repo_root/shared/read-request.sh" "$request_file" all >/dev/null

    DELEGATE_METRICS_FILE="$metrics_file" \
      bash "$repo_root/shared/build-response.sh" completed "bench-$name-worker" "$response_file" \
      <"$fixture_root/$name/response.md" >/dev/null

    DELEGATE_METRICS_FILE="$metrics_file" PATH="$fake_bin:$PATH" \
      bash "$repo_root/shared/dispatch.sh" haiku chore "$request_file" "$response_file" "$run_dir" "$observe_file" >/dev/null

    DELEGATE_METRICS_FILE="$metrics_file" \
      bash "$repo_root/shared/read-response.sh" "$response_file" auto >/dev/null
  done
}

run_fixture_pass "$work_root/warmup.jsonl" "$work_root/warmup"

metrics_file="$work_root/metrics.jsonl"
for i in $(seq 1 "$iterations"); do
  run_fixture_pass "$metrics_file" "$work_root/pass-$i"
done

jq -s \
  --argjson iterations "$iterations" \
  '
  def p50: sort | .[((length * 50 / 100 | ceil) - 1)];
  def durations($kind): [.[] | select(.kind == $kind) | .duration_ms | select(. != null)];
  durations("prepare") as $prepare
  | durations("read_response") as $read_response
  | durations("dispatch") as $dispatch
  | {
      iterations: $iterations,
      samples: {
        prepare: ($prepare | length),
        read_response: ($read_response | length),
        dispatch: ($dispatch | length)
      },
      p50_ms: {
        prepare: ($prepare | p50),
        read_response: ($read_response | p50),
        dispatch: ($dispatch | p50)
      }
    }' "$metrics_file"
