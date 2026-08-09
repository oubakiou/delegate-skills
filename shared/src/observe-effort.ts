import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

// bash 版 observe-json.sh の effort 系関数と同一契約
// (等価性は scripts/observe-parity.test.ts が bash 実装との突き合わせで検証する)。

export interface ModelEffort {
  base_model: string
  effort: string | null
}

export const splitModelEffort = (model: string): ModelEffort => {
  const atIndex = model.indexOf('@')
  if (atIndex === -1) {
    return { base_model: model, effort: null }
  }
  const effort = model.slice(atIndex + 1)
  if (effort === '') {
    return { base_model: model.slice(0, atIndex), effort: null }
  }
  return { base_model: model.slice(0, atIndex), effort }
}

export type EffortValidation = { ok: true } | { ok: false; message: string }

const invalid = (message: string): EffortValidation => ({ ok: false, message })

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CODEX_EFFORTS = new Set([...CLAUDE_EFFORTS, 'ultra'])
const CURSOR_GLM_EFFORTS = new Set(['high', 'max'])
const CURSOR_GROK_EFFORTS = new Set(['low', 'medium', 'high'])
const DEVIN_KIMI_K3_EFFORTS = new Set(['low', 'high', 'max'])

interface BackendEffortRule {
  allowed: Set<string>
  allowedLabel: string
}

const BACKEND_EFFORT_RULES: Readonly<Partial<Record<string, BackendEffortRule>>> = {
  claude: { allowed: CLAUDE_EFFORTS, allowedLabel: 'low|medium|high|xhigh|max' },
  codex: { allowed: CODEX_EFFORTS, allowedLabel: 'low|medium|high|xhigh|max|ultra' },
}

const cursorNamedModelValidation = (
  cursorModel: string,
  model: string,
  effort: string
): EffortValidation | null => {
  if (cursorModel === 'glm-5.2') {
    if (CURSOR_GLM_EFFORTS.has(effort)) {
      return { ok: true }
    }
    return invalid(
      `ERROR: invalid effort '${effort}' for cursor model '${model}'; allowed: high|max`
    )
  }
  if (cursorModel === 'grok-4.5') {
    if (CURSOR_GROK_EFFORTS.has(effort)) {
      return { ok: true }
    }
    return invalid(
      `ERROR: invalid effort '${effort}' for cursor model '${model}'; allowed: low|medium|high`
    )
  }
  return null
}

const validateCursorEffort = (model: string, base: string, effort: string): EffortValidation => {
  let cursorModel = base
  if (cursorModel.startsWith('cursor-')) {
    cursorModel = cursorModel.slice('cursor-'.length)
  }
  if (cursorModel.endsWith('-high') || cursorModel.endsWith('-max')) {
    const withoutSlug = base.slice(0, base.lastIndexOf('-'))
    return invalid(
      `ERROR: effort suffix cannot be combined with the effort slug in cursor model '${model}'; use either '${base}' or '${withoutSlug}@<effort>'`
    )
  }
  const named = cursorNamedModelValidation(cursorModel, model, effort)
  if (named !== null) {
    return named
  }
  return invalid(
    `ERROR: effort suffix is not supported for cursor model '${model}'; supported: cursor-glm-5.2@(high|max), cursor-grok-4.5@(low|medium|high)`
  )
}

// Devin CLI に effort フラグは無く、model variant slug（kimi-k3-high 等）でのみ
// 表現されるため、variant を持つと確認済みのモデルだけ suffix を許容する
const validateDevinEffort = (model: string, base: string, effort: string): EffortValidation => {
  let devinModel = base
  if (devinModel.startsWith('devin-')) {
    devinModel = devinModel.slice('devin-'.length)
  }
  if (devinModel === 'kimi-k3') {
    if (DEVIN_KIMI_K3_EFFORTS.has(effort)) {
      return { ok: true }
    }
    return invalid(
      `ERROR: invalid effort '${effort}' for devin model '${model}'; allowed: low|high|max`
    )
  }
  return invalid(
    `ERROR: effort suffix is not supported for devin model '${model}'; supported: devin-kimi-k3@(low|high|max)`
  )
}

interface EffortContext {
  backend: string
  model: string
  base: string
  effort: string
}

const validateBackendEffort = (context: EffortContext): EffortValidation => {
  const rule = BACKEND_EFFORT_RULES[context.backend]
  if (typeof rule !== 'undefined') {
    if (rule.allowed.has(context.effort)) {
      return { ok: true }
    }
    return invalid(
      `ERROR: invalid effort '${context.effort}' for ${context.backend} backend model '${context.model}'; allowed: ${rule.allowedLabel}`
    )
  }
  if (context.backend === 'cursor') {
    return validateCursorEffort(context.model, context.base, context.effort)
  }
  if (context.backend === 'devin') {
    return validateDevinEffort(context.model, context.base, context.effort)
  }
  return invalid(
    `ERROR: effort suffix is not supported for the ${context.backend} backend (model '${context.model}'); remove '@${context.effort}'`
  )
}

// effort suffix の backend 別検証。許容値は実 CLI の PoC 実測に基づく
// （docs/archive/delegate-effort-suffix.archive.md §2）。fail-closed。
export const validateModelEffort = (backend: string, model: string): EffortValidation => {
  if (!model.includes('@')) {
    return { ok: true }
  }
  const atIndex = model.indexOf('@')
  const base = model.slice(0, atIndex)
  const effort = model.slice(atIndex + 1)
  if (base === '' || effort === '') {
    return invalid(`ERROR: malformed effort suffix in model '${model}'; expected <model>@<effort>`)
  }
  if (effort.includes('@')) {
    return invalid(
      `ERROR: malformed effort suffix in model '${model}'; expected a single @<effort>`
    )
  }
  return validateBackendEffort({ backend, model, base, effort })
}

const CURSOR_GROK_SLUG_PATTERN = /^cursor-grok-4\.5-(?<effort>low|medium|high)$/

// cursor model 名の問題を理由文字列で返す純粋な述語（問題無しなら null）。
// 判定とメッセージ生成を分離し、修正表記の提案値の検証にも再利用する
const cursorModelNameIssue = (model: string): string | null => {
  const { base_model: base } = splitModelEffort(model)
  if (base.startsWith('cursor-cursor-')) {
    return "the 'cursor-' backend prefix must appear exactly once"
  }
  if (CURSOR_GROK_SLUG_PATTERN.test(base)) {
    return "grok effort must be specified with the '@' suffix, not the catalog slug"
  }
  return null
}

// 先頭の cursor- が 2 個以上続く間 1 個ずつ削り、selector を 1 個にする
const collapseCursorSelectors = (base: string): string => {
  let stripped = base
  while (stripped.startsWith('cursor-cursor-')) {
    stripped = stripped.slice('cursor-'.length)
  }
  return stripped
}

// composer* は selector 無しで cursor backend に解決されるため、文書の正規形に合わせて
// selector ごと落とす
const dropComposerSelector = (collapsed: string): string => {
  if (collapsed.startsWith('cursor-composer-')) {
    return collapsed.slice('cursor-'.length)
  }
  return collapsed
}

const reattachEffort = (base: string, effort: string | null): string => {
  if (effort === null) {
    return base
  }
  return `${base}@${effort}`
}

// 修正表記の導出。grok の effort slug は '@' 表記へ畳む（slug 自体が effort を持つため
// もとの suffix は再付与しない）。それ以外は削った base にもとの suffix を引き継ぐ
const correctedCursorModel = (model: string): string => {
  const { base_model: base, effort } = splitModelEffort(model)
  const collapsed = collapseCursorSelectors(base)
  const grokSlug = CURSOR_GROK_SLUG_PATTERN.exec(collapsed)
  if (grokSlug !== null) {
    return `cursor-grok-4.5@${grokSlug[1]}`
  }
  return reattachEffort(dropComposerSelector(collapsed), effort)
}

// 提案値が name / effort 両方の検証を通るときだけ具体値を断定する。通らない提案値を
// 「新規 run で使う値」として案内すると復旧手順が成立しないため、その場合は
// ドキュメント済みの表記を参照させるに留める
const cursorCorrectionGuidance = (model: string): string => {
  const corrected = correctedCursorModel(model)
  if (cursorModelNameIssue(corrected) === null && validateModelEffort('cursor', corrected).ok) {
    return `'${corrected}'`
  }
  return "a documented cursor model notation ('cursor-grok-4.5[@<effort>]', etc.)"
}

// follow-up は継承した指定子を変更できないため、修正提示ではなく新規 run の案内に分岐する
const invalidCursorModel = (
  model: string,
  source: 'requested' | 'followup',
  reason: string
): EffortValidation => {
  const guidance = cursorCorrectionGuidance(model)
  if (source === 'followup') {
    return invalid(
      `ERROR: inherited cursor model '${model}' from the previous session is no longer valid; start a new resumable run with ${guidance}`
    )
  }
  return invalid(`ERROR: invalid cursor model '${model}': ${reason}; use ${guidance}`)
}

// cursor の model 名検証。validateModelEffort は '@' 無しを早期 return する契約のため、
// 二重 prefix（cursor-cursor-*）と grok の effort slug 直指定はここで別途拒否する。
// 二重 prefix は CLI 側では受理され observe の表記揺れとして残り、slug 直指定は
// '@' 表記との 2 系統化で telemetry が割れるため、両方を dispatch 前に止めて
// 表記を cursor-grok-4.5[@effort] の 1 系統に収束させる。fail-closed。
export const validateModelName = (
  backend: string,
  model: string,
  source: 'requested' | 'followup'
): EffortValidation => {
  if (backend !== 'cursor') {
    return { ok: true }
  }
  const issue = cursorModelNameIssue(model)
  if (issue === null) {
    return { ok: true }
  }
  return invalidCursorModel(model, source, issue)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// jq の `//` は null と false を「無し」として次候補に落とす
const jqCoalesce = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value !== null && value !== false && typeof value !== 'undefined') {
      return value
    }
  }
  return null
}

// find の出力順 (readdir 生順) を保つため sort しない。読めない entry は
// bash 版の `find/xargs 2>/dev/null` と同じく黙って skip する
const readDirEntriesOrEmpty = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const collectJsonlFiles = (dir: string): string[] => {
  const files: string[] = []
  for (const entry of readDirEntriesOrEmpty(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full)
    }
  }
  return files
}

const readFileOrEmpty = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const parseJsonLine = (line: string): unknown => {
  if (line.length === 0) {
    return null
  }
  try {
    return JSON.parse(line)
  } catch {
    // 不正行は skip (jq: try fromjson catch empty)
    return null
  }
}

const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

export interface EffectiveEffort {
  value: unknown
  source: string
  fast?: boolean
}

const collectTurnContexts = (sessionsDir: string): Record<string, unknown>[] => {
  const contexts: Record<string, unknown>[] = []
  for (const file of collectJsonlFiles(sessionsDir)) {
    for (const line of readFileOrEmpty(file).split('\n')) {
      const value = parseJsonLine(line)
      if (isRecord(value) && value.type === 'turn_context' && isRecord(value.payload)) {
        contexts.push(value.payload)
      }
    }
  }
  return contexts
}

const codexEffortFromPayload = (payload: Record<string, unknown>): EffectiveEffort => {
  // effort のフィールド名は Codex CLI のバージョンで揺れる
  const effort = jqCoalesce(
    payload.effort,
    payload.reasoning_effort,
    payload.model_reasoning_effort
  )
  if (typeof effort === 'string') {
    return { value: effort, source: 'measured' }
  }
  return { value: null, source: 'backend_default' }
}

// 実効 effort の抽出は「artifacts で確認できた事実」だけを記録する:
// measured / backend_default / not_exposed（呼び出し側が null 時に用いる）
export const effortFromCodexSessions = (codexHome: string): EffectiveEffort | null => {
  const sessionsDir = path.join(codexHome, 'sessions')
  if (!isDirectory(sessionsDir)) {
    return null
  }
  const contexts = collectTurnContexts(sessionsDir)
  if (contexts.length === 0) {
    return null
  }
  return codexEffortFromPayload(contexts[contexts.length - 1])
}

const cursorSlugEffort = (model: string): string => {
  if (model.endsWith('-high')) {
    return 'high'
  }
  if (model.endsWith('-max')) {
    return 'max'
  }
  return ''
}

const readConfigJson = (cliConfig: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cliConfig, 'utf8'))
    if (isRecord(parsed)) {
      return parsed
    }
  } catch {
    // cli-config が無い・壊れている場合も slug からの抽出は成立させる
  }
  return {}
}

const modelParametersFor = (config: Record<string, unknown>, model: string): unknown[] | null => {
  const { modelParameters } = config
  if (!isRecord(modelParameters)) {
    return null
  }
  const params: unknown = modelParameters[model]
  if (params === null || typeof params === 'undefined') {
    return null
  }
  if (Array.isArray(params)) {
    return params
  }
  return []
}

const selectedModelParamsFor = (
  config: Record<string, unknown>,
  model: string
): unknown[] | null => {
  const { selectedModel } = config
  if (isRecord(selectedModel) && selectedModel.modelId === model) {
    const params: unknown = selectedModel.parameters
    if (Array.isArray(params)) {
      return params
    }
  }
  return null
}

const cursorParamsFor = (config: Record<string, unknown>, model: string): unknown[] =>
  modelParametersFor(config, model) ?? selectedModelParamsFor(config, model) ?? []

const resolveCursorParams = (
  config: Record<string, unknown>,
  model: string,
  baseModel: string
): unknown[] => {
  const params = cursorParamsFor(config, model)
  if (params.length > 0) {
    return params
  }
  return cursorParamsFor(config, baseModel)
}

const firstParamValue = (params: unknown[], ids: readonly string[]): unknown => {
  for (const param of params) {
    if (isRecord(param) && typeof param.id === 'string' && ids.includes(param.id)) {
      // jq の `first // null` は false も null に落とすため、false は「無し」扱い
      return jqCoalesce(param.value)
    }
  }
  return null
}

const asFastBoolean = (fastRaw: unknown): boolean => {
  if (typeof fastRaw === 'boolean') {
    return fastRaw
  }
  return fastRaw === 'true'
}

const buildCursorEffort = (effort: unknown, fastRaw: unknown): EffectiveEffort => {
  const result: EffectiveEffort = { value: null, source: 'not_exposed' }
  if (effort !== null) {
    result.value = effort
    result.source = 'measured'
  }
  if (fastRaw !== null) {
    result.fast = asFastBoolean(fastRaw)
  }
  return result
}

export const effortFromCursorConfig = (model: string, cliConfig: string): EffectiveEffort => {
  // slug（-high / -max）は CLI argv に載る宣言そのものなので cli-config より優先する
  const slugEffort = cursorSlugEffort(model)
  let baseModel = model
  if (slugEffort !== '') {
    baseModel = model.slice(0, model.lastIndexOf('-'))
  }
  const params = resolveCursorParams(readConfigJson(cliConfig), model, baseModel)
  let effort = firstParamValue(params, ['effort', 'reasoning'])
  if (slugEffort !== '') {
    effort = slugEffort
  }
  return buildCursorEffort(effort, firstParamValue(params, ['fast']))
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const messageOf = (result: EffortValidation): string => {
  if (result.ok) {
    throw new Error('expected a rejection')
  }
  return result.message
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  describe('splitModelEffort', () => {
    it('splits at the first @ and maps an empty effort to null', () => {
      expect(splitModelEffort('gpt-5.5@high')).toEqual({ base_model: 'gpt-5.5', effort: 'high' })
      expect(splitModelEffort('haiku')).toEqual({ base_model: 'haiku', effort: null })
      expect(splitModelEffort('model@')).toEqual({ base_model: 'model', effort: null })
      expect(splitModelEffort('a@b@c')).toEqual({ base_model: 'a', effort: 'b@c' })
    })
  })

  describe('validateModelEffort', () => {
    it('accepts documented suffixes and passes through suffix-less models', () => {
      expect(validateModelEffort('claude', 'sonnet').ok).toBe(true)
      expect(validateModelEffort('claude', 'sonnet@xhigh').ok).toBe(true)
      expect(validateModelEffort('codex', 'gpt-5.5@ultra').ok).toBe(true)
      expect(validateModelEffort('cursor', 'cursor-glm-5.2@max').ok).toBe(true)
      expect(validateModelEffort('cursor', 'cursor-grok-4.5@low').ok).toBe(true)
      expect(validateModelEffort('devin', 'devin-kimi-k3@low').ok).toBe(true)
      expect(validateModelEffort('devin', 'devin-kimi-k3@high').ok).toBe(true)
      expect(validateModelEffort('devin', 'devin-kimi-k3@max').ok).toBe(true)
    })

    it('fails closed on invalid, doubled, or unsupported suffixes', () => {
      expect(validateModelEffort('claude', 'sonnet@ultra').ok).toBe(false)
      expect(validateModelEffort('codex', 'gpt-5.5@hi@gh').ok).toBe(false)
      expect(validateModelEffort('cursor', 'cursor-glm-5.2-high@max').ok).toBe(false)
      expect(validateModelEffort('cursor', 'composer-2.5@high').ok).toBe(false)
      expect(validateModelEffort('devin', 'swe-1.7@high').ok).toBe(false)
      expect(validateModelEffort('devin', 'devin-kimi-k3@medium').ok).toBe(false)
      expect(validateModelEffort('devin', 'devin-glm-5.2@high').ok).toBe(false)
      expect(validateModelEffort('grok', 'grok-build@low').ok).toBe(false)
    })
  })

  describe('validateModelName', () => {
    it('rejects a doubled cursor- prefix and points at the canonical notation', () => {
      const message = messageOf(
        validateModelName('cursor', 'cursor-cursor-grok-4.5-medium', 'requested')
      )
      expect(message).toContain("invalid cursor model 'cursor-cursor-grok-4.5-medium'")
      expect(message).toContain('must appear exactly once')
      expect(message).toContain("use 'cursor-grok-4.5@medium'")
    })

    it('rejects the direct grok effort slug and keeps the requested effort suffix', () => {
      for (const effort of ['low', 'medium', 'high']) {
        const message = messageOf(
          validateModelName('cursor', `cursor-grok-4.5-${effort}`, 'requested')
        )
        expect(message).toContain(`use 'cursor-grok-4.5@${effort}'`)
      }
      expect(
        messageOf(validateModelName('cursor', 'cursor-cursor-glm-5.2@max', 'requested'))
      ).toContain("use 'cursor-glm-5.2@max'")
    })

    it('guides a follow-up inheritance to a new run instead of a fixed specifier', () => {
      const message = messageOf(
        validateModelName('cursor', 'cursor-cursor-grok-4.5-medium', 'followup')
      )
      expect(message).toContain('from the previous session is no longer valid')
      expect(message).toContain("start a new resumable run with 'cursor-grok-4.5@medium'")
      expect(message).not.toContain("use '")
    })

    it('suggests the documented selector-less notation for a doubled composer prefix', () => {
      const message = messageOf(
        validateModelName('cursor', 'cursor-cursor-composer-2.5', 'requested')
      )
      expect(message).toContain("use 'composer-2.5'")
    })

    it('collapses three or more leading cursor- prefixes to a single selector', () => {
      const message = messageOf(
        validateModelName('cursor', 'cursor-cursor-cursor-composer-2.5', 'requested')
      )
      expect(message).toContain("use 'composer-2.5'")
    })

    it('does not assert a concrete suggestion when the derived value fails validation', () => {
      // cursor-cursor-glm-5.2-high@max の導出値は slug と '@' の二重指定で無効なため、
      // 具体値ではなくドキュメント済み表記を参照させる
      const message = messageOf(
        validateModelName('cursor', 'cursor-cursor-glm-5.2-high@max', 'requested')
      )
      expect(message).toContain("invalid cursor model 'cursor-cursor-glm-5.2-high@max'")
      expect(message).not.toContain("use 'cursor-glm-5.2-high@max'")
      expect(message).toContain("a documented cursor model notation ('cursor-grok-4.5[@<effort>]'")
      const followupMessage = messageOf(
        validateModelName('cursor', 'cursor-cursor-glm-5.2-high@max', 'followup')
      )
      expect(followupMessage).not.toContain("run with 'cursor-glm-5.2-high@max'")
      expect(followupMessage).toContain(
        'start a new resumable run with a documented cursor model notation'
      )
    })

    it('accepts documented cursor notations', () => {
      for (const model of [
        'cursor-glm-5.2-high',
        'cursor-glm-5.2@max',
        'cursor-grok-4.5',
        'cursor-grok-4.5@medium',
        'composer-2.5',
      ]) {
        expect(validateModelName('cursor', model, 'requested')).toEqual({ ok: true })
        expect(validateModelName('cursor', model, 'followup')).toEqual({ ok: true })
      }
    })

    it('passes through models of non-cursor backends unconditionally', () => {
      for (const backend of ['claude', 'codex', 'devin']) {
        expect(validateModelName(backend, 'cursor-cursor-grok-4.5-medium', 'requested')).toEqual({
          ok: true,
        })
        expect(validateModelName(backend, 'cursor-grok-4.5-low', 'followup')).toEqual({
          ok: true,
        })
      }
    })
  })

  describe('effortFromCursorConfig', () => {
    it('prefers the model slug over cli-config parameters', () => {
      const result = effortFromCursorConfig('glm-5.2-max', '/nonexistent-config.json')
      expect(result).toEqual({ value: 'max', source: 'measured' })
    })

    it('reads the effort recorded under the base model after a catalog slug run', () => {
      mkdirSync('.temp', { recursive: true })
      const dir = mkdtempSync(path.join('.temp', 'observe-effort-test-'))
      try {
        // catalog slug（cursor-grok-4.5-low）で run した後の cli-config の実測形状。
        // CLI 側が base 名（grok-4.5）へ正規化して記録する
        const cliConfig = path.join(dir, 'cli-config.json')
        writeFileSync(
          cliConfig,
          JSON.stringify({
            selectedModel: {
              modelId: 'grok-4.5',
              parameters: [
                { id: 'effort', value: 'low' },
                { id: 'fast', value: 'false' },
              ],
            },
            modelParameters: {
              'grok-4.5': [
                { id: 'effort', value: 'low' },
                { id: 'fast', value: 'false' },
              ],
            },
          })
        )
        expect(effortFromCursorConfig('grok-4.5', cliConfig)).toEqual({
          value: 'low',
          source: 'measured',
          fast: false,
        })
      } finally {
        rmSync(dir, { force: true, recursive: true })
      }
    })
  })
}
