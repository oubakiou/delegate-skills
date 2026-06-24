#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline="$repo_root/fixtures/metrics/baseline.json"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/delegate-metrics-baseline.XXXXXX")"
current="$work_dir/current-baseline.json"
expected="$work_dir/expected-baseline.json"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

bash "$repo_root/scripts/run-metrics-fixtures.sh" --json | jq '
  [
    .[] | {
      name,
      records,
      orchestrationEvents,
      workerReadRequestEstimatedTokens: .totals.workerReadRequestEstimatedTokens,
      mainReadResponseEstimatedTokens: .totals.mainReadResponseEstimatedTokens,
      inlineTrue: .inline.true,
      inlineFalse: .inline.false
    }
  ]
' >"$current"

jq '.' "$baseline" >"$expected"

if diff -u "$expected" "$current"; then
  printf 'metrics baseline: ok\n'
else
  printf '\nmetrics baseline drift detected.\n' >&2
  printf 'Review the proxy metric change, then update %s if intentional.\n' "$baseline" >&2
  exit 1
fi
