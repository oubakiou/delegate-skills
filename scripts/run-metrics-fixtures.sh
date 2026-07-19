#!/usr/bin/env bash
set -euo pipefail

json=false
if [ "${1:-}" = "--json" ]; then
  json=true
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$repo_root/fixtures/metrics"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/delegate-metrics-fixtures.XXXXXX")"
fixtures=(scriptable-chore read-heavy-chore mixed-chore)
result_files=()

# dispatch record を実 CLI 抜きで決定論的に生成するための fake claude CLI。
# stream-json の形（assistant の tool_use 1 件 + result の num_turns 2）を固定し、
# timing の model_turns / tool_calls をベースラインで監視できるようにする
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

for name in "${fixtures[@]}"; do
  fixture_dir="$fixture_root/$name"
  work_dir="$work_root/$name"
  metrics_file="$work_dir/metrics.jsonl"

  rm -rf "$work_dir"
  mkdir -p "$work_dir"

  out="$(
    DELEGATE_WORK_DIR="$work_dir" \
      DELEGATE_METRICS_FILE="$metrics_file" \
      bash "$repo_root/shared/prepare.sh" chore DELEGATE_CHORE_MODEL haiku '[]' "fixture-$name" \
      <"$fixture_dir/request.md"
  )"
  request_file="$(printf '%s' "$out" | jq -r .request_file)"
  response_file="$(printf '%s' "$out" | jq -r .response_file)"
  run_dir="$(printf '%s' "$out" | jq -r .run_dir)"
  observe_file="$(printf '%s' "$out" | jq -r .observe_file)"

  DELEGATE_METRICS_FILE="$metrics_file" \
    bash "$repo_root/shared/read-request.sh" "$request_file" all >/dev/null

  DELEGATE_METRICS_FILE="$metrics_file" \
    bash "$repo_root/shared/build-response.sh" completed "fixture-$name-worker" "$response_file" \
    <"$fixture_dir/response.md" >/dev/null

  DELEGATE_METRICS_FILE="$metrics_file" PATH="$fake_bin:$PATH" \
    bash "$repo_root/shared/dispatch.sh" haiku chore "$request_file" "$response_file" "$run_dir" "$observe_file" >/dev/null

  DELEGATE_METRICS_FILE="$metrics_file" \
    bash "$repo_root/shared/read-response.sh" "$response_file" auto >/dev/null

  node "$repo_root/scripts/summarize-metrics.ts" --json "$metrics_file" >"$work_dir/summary.json"
  jq \
    --arg name "$name" \
    --arg metricsFile "$metrics_file" \
    --arg workDir "$work_dir" \
    '. + {name: $name, metricsFile: $metricsFile, workDir: $workDir}' \
    "$work_dir/summary.json" >"$work_dir/result.json"
  result_files+=("$work_dir/result.json")
done

if [ "$json" = true ]; then
  jq -s '.' "${result_files[@]}"
else
  for name in "${fixtures[@]}"; do
    work_dir="$work_root/$name"
    metrics_file="$work_dir/metrics.jsonl"
    printf '# %s\n' "$name"
    printf 'work_dir: %s\n' "$work_dir"
    printf 'metrics: %s\n\n' "$metrics_file"
    node "$repo_root/scripts/summarize-metrics.ts" "$metrics_file"
    printf '\n'
  done
fi
