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

// Cursor は `grok-4.5[effort=medium]` のように bracket 込みの model 名を拒否する。
// 抽出値は Markdown へ転記されるため、bracket 内も含めて文字種と長さを閉じる
const CURSOR_MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}(?:\[[A-Za-z0-9._,=-]{1,64}\])?$/

const MAX_CANDIDATES = 8

interface FailureSignatureBase {
  // 行全体に anchor する。部分一致だと他ツールの診断行や別のエラーブロックを
  // 拾って、無関係な失敗をモデル解決失敗と誤断定する
  unknownModelLine: RegExp
  // 拒否された model 名の allowlist。拒否名の文字種は backend ごとに異なる
  // （Cursor は bracket 込みで拒否する）ため signature 単位で持つ
  modelPattern: RegExp
}

// Devin レイアウト: `Unknown model:` 行の後に marker 行があり、次行以降が 1 行 1 候補
interface BlockCandidatesSignature extends FailureSignatureBase {
  candidatesLayout: 'block'
  // 候補列挙の marker は完全一致で判定する。startsWith だと `Available:not-a-marker` や
  // 同一行に候補が続く `Available: a, b` を「候補 0 件 = カタログ空」と誤断定する
  availableMarker: string
}

// Cursor レイアウト: 1 行完結で、候補は model 行の marker 以降に `, ` 区切りで並ぶ。
// unknownModelLine が候補部分を candidates group で capture する
interface InlineCandidatesSignature extends FailureSignatureBase {
  candidatesLayout: 'inline'
}

type FailureSignature = BlockCandidatesSignature | InlineCandidatesSignature

// `Unknown model:` + `Available:`（Devin）と `Cannot use this model:` +
// `Available models:`（Cursor）の文言は各 CLI で実観測済み。未確認 backend に
// 共通適用すると別種の失敗を誤分類するため、claude / codex / imagegen / xresearch は
// 実観測が取れるまで登録しない
const signatures: Record<string, readonly FailureSignature[]> = {
  devin: [
    {
      unknownModelLine: /^(?:Error: )?Unknown model: '(?<model>[^']*)'$/,
      modelPattern: SLUG_PATTERN,
      candidatesLayout: 'block',
      availableMarker: 'Available:',
    },
  ],
  cursor: [
    {
      // 候補部は 1 スペース + 1 文字以上がある場合だけ capture する。capture が無い
      // （`Available models:` で行末）場合は空カタログと tail 切断を区別できず、
      // capture があっても検証を通る候補が無ければ未観測の区切り書式の可能性がある。
      // いずれも unknown に落とし、観測できた書式だけを受理する（fail-closed）
      unknownModelLine:
        /^Cannot use this model: (?<model>\S+)\. Available models:(?: (?<candidates>.+))?$/,
      modelPattern: CURSOR_MODEL_PATTERN,
      candidatesLayout: 'inline',
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

// 候補側に bracket は現れないため、各要素は SLUG_PATTERN で濾す。
// 不適合な要素が出た時点で打ち切る作法は block レイアウトと同じ
const collectInlineCandidates = (candidatesText: string): string[] => {
  const candidates: string[] = []
  for (const entry of candidatesText.split(', ')) {
    if (!SLUG_PATTERN.test(entry)) {
      break
    }
    candidates.push(entry)
  }
  return candidates
}

interface ParsedModelLine {
  model: string
  // inline レイアウトでのみ capture される。block レイアウトでは undefined
  candidatesText?: string
}

const parseModelLine = (signature: FailureSignature, line: string): ParsedModelLine | null => {
  const match = signature.unknownModelLine.exec(line)
  if (match === null || typeof match.groups === 'undefined') {
    return null
  }
  const { model, candidates } = match.groups
  if (!signature.modelPattern.test(model)) {
    return null
  }
  return { model, candidatesText: candidates }
}

// 次の Unknown model 行までを 1 エラーブロックとして扱う。ブロックを越えて marker を
// 探すと、別の失敗の候補列挙を今回の model に結び付けてしまう
const blockAfter = (
  signature: BlockCandidatesSignature,
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
  signature: BlockCandidatesSignature,
  block: readonly string[],
  model: string
): ChildFailure => {
  const markerIndex = block.indexOf(signature.availableMarker)
  if (markerIndex === -1) {
    return unknown
  }
  return resultFromCandidates(model, collectCandidates(block.slice(markerIndex + 1)))
}

// inline レイアウトでは空の候補列を「カタログ空 = retryable」と断定しない。
// capture 不在（marker で行末）は空カタログと tail 切断を区別できず、capture が
// あっても検証を通る候補が 0 件なら未観測の区切り書式の可能性がある。Cursor の
// 空カタログ書式は未観測なので、いずれも unknown に落とす（block レイアウトの
// marker 不在で unknown に落とすのと同じ fail-closed 原則）
const classifyInline = (model: string, candidatesText: string | undefined): ChildFailure => {
  if (typeof candidatesText === 'undefined') {
    return unknown
  }
  const candidates = collectInlineCandidates(candidatesText)
  if (candidates.length === 0) {
    return unknown
  }
  return resultFromCandidates(model, candidates)
}

const classifyWithSignature = (signature: FailureSignature, stderrTail: string): ChildFailure => {
  const lines = stderrTail.split('\n').map((line) => line.trimEnd())
  const modelIndex = lines.findIndex((line) => signature.unknownModelLine.test(line))
  if (modelIndex === -1) {
    return unknown
  }
  const parsed = parseModelLine(signature, lines[modelIndex])
  if (parsed === null) {
    return unknown
  }
  if (signature.candidatesLayout === 'inline') {
    return classifyInline(parsed.model, parsed.candidatesText)
  }
  return classifyBlock(signature, blockAfter(signature, lines, modelIndex + 1), parsed.model)
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

  const cursorBackend = 'cursor'
  const cursorInput = (stderrTail: string): { backend: string; stderrTail: string } => ({
    backend: cursorBackend,
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

  describe('cursor one-line layout', () => {
    it('classifies the observed one-line comma-separated stderr as model_not_found with truncation', () => {
      const listed = listedModels(9)
      expect(
        classifyChildFailure(
          cursorInput(
            `Cannot use this model: grok-4.5[effort=medium]. Available models: ${listed.join(', ')}`
          )
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'grok-4.5[effort=medium]',
        candidates: listed.slice(0, 8),
        candidatesTruncated: true,
      })
    })

    it('classifies a rejected model name containing brackets', () => {
      expect(
        classifyChildFailure(
          cursorInput(
            'Cannot use this model: grok-4.5[effort=medium]. Available models: auto, glm-5.2-max'
          )
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'grok-4.5[effort=medium]',
        candidates: ['auto', 'glm-5.2-max'],
        candidatesTruncated: false,
      })
    })

    it('returns unknown when the line ends at the marker without candidates', () => {
      // 空カタログと tail 切断を区別できないため、model_catalog_unavailable には断定しない
      expect(
        classifyChildFailure(cursorInput('Cannot use this model: grok-4.5. Available models:'))
      ).toEqual({ kind: 'unknown' })
      expect(
        classifyChildFailure(cursorInput('Cannot use this model: grok-4.5. Available models: '))
      ).toEqual({ kind: 'unknown' })
    })

    it('returns unknown when no candidate passes validation', () => {
      // 未観測の区切り書式（スペース無しのカンマ区切り等）は unknown に落とす
      expect(
        classifyChildFailure(
          cursorInput('Cannot use this model: x. Available models: auto,glm-5.2')
        )
      ).toEqual({ kind: 'unknown' })
    })

    it('classifies a well-formed inline candidate list as model_not_found', () => {
      expect(
        classifyChildFailure(
          cursorInput('Cannot use this model: x. Available models: auto, glm-5.2')
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'x',
        candidates: ['auto', 'glm-5.2'],
        candidatesTruncated: false,
      })
    })

    it('stops inline candidate collection at the first non-candidate entry', () => {
      expect(
        classifyChildFailure(
          cursorInput(
            'Cannot use this model: grok-4.5. Available models: auto, * see docs, glm-5.2-max'
          )
        )
      ).toEqual({
        kind: 'model_not_found',
        retryable: false,
        model: 'grok-4.5',
        candidates: ['auto'],
        candidatesTruncated: false,
      })
    })

    it('returns unknown when the model name contains markdown control characters', () => {
      const tails = [
        'Cannot use this model: grok-4.5`x`. Available models: auto',
        'Cannot use this model: grok-4.5|x. Available models: auto',
        'Cannot use this model: grok 4.5. Available models: auto',
        'Cannot use this model: grok-4.5\n[effort=medium]. Available models: auto',
      ]
      for (const stderrTail of tails) {
        expect(classifyChildFailure(cursorInput(stderrTail))).toEqual({ kind: 'unknown' })
      }
    })

    it('returns unknown when the tail is cut off before the model line completes', () => {
      expect(
        classifyChildFailure(
          cursorInput('partial prefix\nCannot use this model: grok-4.5[effort=medi')
        )
      ).toEqual({ kind: 'unknown' })
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
