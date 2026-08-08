export type ChildFailure =
  | { kind: 'unknown' }
  | { kind: 'model_catalog_unavailable'; retryable: true; model: string }
  | {
      kind: 'model_not_found'
      retryable: false
      model: string
      candidates: readonly string[]
      // 出力側が 8 件ちょうどと 9 件以上を区別して省略記号を付けるために持たせる。
      // candidates は先頭 8 件に切り詰め済みなので、件数だけからは超過の有無を復元できない
      candidatesTruncated: boolean
    }

// slug と候補名を厳格な文字種・長さに制限するのは、stderr の任意テキストが
// response (Markdown) へ転記される経路を塞ぐため
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

const MAX_CANDIDATES = 8

interface FailureSignature {
  // 行全体に anchor する。部分一致だと他ツールの診断行や別のエラーブロックを
  // 拾って、無関係な失敗をモデル解決失敗と誤断定する
  unknownModelLine: RegExp
  // 候補列挙の marker は完全一致で判定する。startsWith だと `Available:not-a-marker` や
  // 同一行に候補が続く `Available: a, b` を「候補 0 件 = カタログ空」と誤断定する
  availableMarker: string
}

// `Unknown model:` + `Available:` の文言は Devin CLI でのみ実観測済み。
// 未確認 backend に共通適用すると別種の失敗を誤分類するため、
// claude / codex / cursor / imagegen / xresearch は実観測が取れるまで登録しない
const signatures: Record<string, readonly FailureSignature[]> = {
  devin: [
    {
      unknownModelLine: /^(?:Error: )?Unknown model: '(?<model>[^']*)'$/,
      availableMarker: 'Available:',
    },
  ],
}

const unknown: ChildFailure = { kind: 'unknown' }

const collectCandidates = (lines: readonly string[]): string[] => {
  const candidates: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!SLUG_PATTERN.test(trimmed)) {
      break
    }
    candidates.push(trimmed)
  }
  return candidates
}

const modelOfLine = (signature: FailureSignature, line: string): string | null => {
  const match = signature.unknownModelLine.exec(line)
  if (match === null || typeof match.groups === 'undefined') {
    return null
  }
  const { model } = match.groups
  if (!SLUG_PATTERN.test(model)) {
    return null
  }
  return model
}

// 次の Unknown model 行までを 1 エラーブロックとして扱う。ブロックを越えて marker を
// 探すと、別の失敗の候補列挙を今回の model に結び付けてしまう
const blockAfter = (
  signature: FailureSignature,
  lines: readonly string[],
  start: number
): readonly string[] => {
  const rest = lines.slice(start)
  const nextIndex = rest.findIndex((line) => signature.unknownModelLine.test(line))
  if (nextIndex === -1) {
    return rest
  }
  return rest.slice(0, nextIndex)
}

const resultFromCandidates = (model: string, candidates: readonly string[]): ChildFailure => {
  if (candidates.length === 0) {
    return { kind: 'model_catalog_unavailable', retryable: true, model }
  }
  return {
    kind: 'model_not_found',
    retryable: false,
    model,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidatesTruncated: candidates.length > MAX_CANDIDATES,
  }
}

// tail の途中切断・別レイアウト・CLI 文面変更では marker が消え得る。
// 「候補列挙が観測できなかった」を「カタログ空 = retryable」と誤断定しないため、
// 同一ブロック内に marker 行が無ければ unknown に落とす
const classifyBlock = (
  signature: FailureSignature,
  block: readonly string[],
  model: string
): ChildFailure => {
  const markerIndex = block.indexOf(signature.availableMarker)
  if (markerIndex === -1) {
    return unknown
  }
  return resultFromCandidates(model, collectCandidates(block.slice(markerIndex + 1)))
}

const classifyWithSignature = (signature: FailureSignature, stderrTail: string): ChildFailure => {
  const lines = stderrTail.split('\n').map((line) => line.trimEnd())
  const modelIndex = lines.findIndex((line) => signature.unknownModelLine.test(line))
  if (modelIndex === -1) {
    return unknown
  }
  const model = modelOfLine(signature, lines[modelIndex])
  if (model === null) {
    return unknown
  }
  return classifyBlock(signature, blockAfter(signature, lines, modelIndex + 1), model)
}

export const classifyChildFailure = (input: {
  backend: string
  stderrTail: string
}): ChildFailure => {
  const backendSignatures = signatures[input.backend] ?? []
  for (const signature of backendSignatures) {
    const result = classifyWithSignature(signature, input.stderrTail)
    if (result.kind !== 'unknown') {
      return result
    }
  }
  return unknown
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest

  const devinBackend = 'devin'
  const devinInput = (stderrTail: string): { backend: string; stderrTail: string } => ({
    backend: devinBackend,
    stderrTail,
  })

  const candidatePrefix = 'model'
  const listedModels = (count: number): string[] => {
    const models: string[] = []
    for (let index = 0; index < count; index += 1) {
      models.push(`${candidatePrefix}-${index}`)
    }
    return models
  }

  describe('classification with candidates', () => {
    it('classifies an empty candidate list as model_catalog_unavailable', () => {
      expect(
        classifyChildFailure(devinInput("Unknown model: 'kimi-k3-max'\nAvailable:\n"))
      ).toEqual({ kind: 'model_catalog_unavailable', retryable: true, model: 'kimi-k3-max' })
    })

    it('classifies a non-empty candidate list as model_not_found', () => {
      expect(
        classifyChildFailure(
          devinInput("Unknown model: 'kimi-k3-max'\nAvailable:\ngpt-5\nclaude-opus\ndevin-x\n")
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'kimi-k3-max',
        candidates: ['gpt-5', 'claude-opus', 'devin-x'],
        candidatesTruncated: false,
      })
    })

    it('keeps exactly 8 candidates without truncation', () => {
      const listed = listedModels(8)
      expect(
        classifyChildFailure(
          devinInput(`Unknown model: 'kimi-k3-max'\nAvailable:\n${listed.join('\n')}\n`)
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'kimi-k3-max',
        candidates: listed,
        candidatesTruncated: false,
      })
    })

    it('truncates 9 candidates to the first 8 with candidatesTruncated: true', () => {
      const listed = listedModels(9)
      expect(
        classifyChildFailure(
          devinInput(`Unknown model: 'kimi-k3-max'\nAvailable:\n${listed.join('\n')}\n`)
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'kimi-k3-max',
        candidates: listed.slice(0, 8),
        candidatesTruncated: true,
      })
    })

    it('stops candidate collection at the first non-candidate line without throwing', () => {
      expect(
        classifyChildFailure(
          devinInput(
            "Unknown model: 'kimi-k3-max'\nAvailable:\ngpt-5\n* see docs for models\nclaude-opus\n"
          )
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'kimi-k3-max',
        candidates: ['gpt-5'],
        candidatesTruncated: false,
      })
    })
  })

  describe('unknown fallbacks', () => {
    it('returns unknown when no Available: line follows the Unknown model line', () => {
      expect(
        classifyChildFailure(devinInput("Unknown model: 'kimi-k3-max'\nsome other output\n"))
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown when the Unknown model line is cut off mid-tail', () => {
      expect(
        classifyChildFailure(devinInput("partial prefix\nUnknown model: 'kimi-k3-ma"))
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown for an empty stderrTail', () => {
      expect(classifyChildFailure(devinInput(''))).toEqual({ kind: 'unknown' })
    })

    it('returns unknown for unregistered backends with the same stderr', () => {
      const stderrTail = "Unknown model: 'kimi-k3-max'\nAvailable:\n"
      for (const backend of ['codex', 'claude', 'cursor']) {
        expect(classifyChildFailure({ backend, stderrTail })).toEqual({ kind: 'unknown' })
      }
    })

    it('returns unknown when the slug violates the character/length constraints', () => {
      const tails = [
        "Unknown model: 'foo bar'\nAvailable:\n",
        `Unknown model: '${'a'.repeat(65)}'\nAvailable:\n`,
        "Unknown model: 'foo'bar'\nAvailable:\n",
      ]
      for (const stderrTail of tails) {
        expect(classifyChildFailure(devinInput(stderrTail))).toEqual({ kind: 'unknown' })
      }
    })

    it('returns unknown when the marker line carries a suffix', () => {
      expect(
        classifyChildFailure(
          devinInput("Error: Unknown model: 'kimi-k3-max'\nAvailable:not-the-marker\n")
        )
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown when the candidates are listed on the marker line itself', () => {
      expect(
        classifyChildFailure(
          devinInput("Error: Unknown model: 'kimi-k3-max'\nAvailable: swe-1.7, devin-glm-5.2\n")
        )
      ).toEqual({ kind: 'unknown' })
    })

    it('does not borrow a later error block catalog for an earlier model', () => {
      expect(
        classifyChildFailure(
          devinInput(
            "Error: Unknown model: 'aaa'\nsomething\nError: Unknown model: 'bbb'\nAvailable:\nswe-1.7\n"
          )
        )
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown when the Unknown model text is embedded in a longer line', () => {
      expect(
        classifyChildFailure(
          devinInput("tool log: Unknown model: 'kimi-k3-max' (ignored)\nAvailable:\n")
        )
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown when Available: only appears before Unknown model:', () => {
      expect(
        classifyChildFailure(devinInput("Available:\ngpt-5\nUnknown model: 'kimi-k3-max'\n"))
      ).toEqual({ kind: 'unknown' })
    })
  })
}
