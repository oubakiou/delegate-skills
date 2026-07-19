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

# duration / p50 の実時間値は実行ごとに揺れるため、ベースラインには決定論的な
# 値（record 数・サンプル数・fake stream 由来の turns / tool_calls・parse 区分）だけを載せる
bash "$repo_root/scripts/run-metrics-fixtures.sh" --json | jq '
  [
    .[] | {
      name,
      records,
      orchestrationEvents,
      workerReadRequestEstimatedTokens: .totals.workerReadRequestEstimatedTokens,
      mainReadResponseEstimatedTokens: .totals.mainReadResponseEstimatedTokens,
      inlineTrue: .inline.true,
      inlineFalse: .inline.false,
      prepareDurationSamples: (.phaseDurations.prepare.samples // 0),
      dispatchDurationSamples: (.phaseDurations.dispatch.samples // 0),
      readResponseDurationSamples: (.phaseDurations.read_response.samples // 0),
      dispatch: (.dispatchByBackendModel["claude/haiku"] // null
        | if . == null then null else {
            count,
            modelTurnsP50: .modelTurns.p50,
            toolCallsP50: .toolCalls.p50,
            timeToFirstUsefulEventSamples: .timeToFirstUsefulEventMs.samples,
            reportReadySamples: .reportReadyAtMs.samples,
            structuredOutputParse: .structuredOutputParse
          } end)
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
