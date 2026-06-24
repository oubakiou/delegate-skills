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

  DELEGATE_METRICS_FILE="$metrics_file" \
    bash "$repo_root/shared/read-request.sh" "$request_file" all >/dev/null

  DELEGATE_METRICS_FILE="$metrics_file" \
    bash "$repo_root/shared/build-response.sh" completed "fixture-$name-worker" "$response_file" \
    <"$fixture_dir/response.md" >/dev/null

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
