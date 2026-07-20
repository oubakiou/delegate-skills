import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

// 凍結中の bash 版 observe-json.sh の effort 系関数と同一契約。両実装が並存する間は
// scripts/observe-parity.test.ts が同一入力での等価性を検証する。

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

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
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
    })

    it('fails closed on invalid, doubled, or unsupported suffixes', () => {
      expect(validateModelEffort('claude', 'sonnet@ultra').ok).toBe(false)
      expect(validateModelEffort('codex', 'gpt-5.5@hi@gh').ok).toBe(false)
      expect(validateModelEffort('cursor', 'cursor-glm-5.2-high@max').ok).toBe(false)
      expect(validateModelEffort('cursor', 'composer-2.5@high').ok).toBe(false)
      expect(validateModelEffort('devin', 'swe-1.7@high').ok).toBe(false)
      expect(validateModelEffort('grok', 'grok-build@low').ok).toBe(false)
    })
  })

  describe('effortFromCursorConfig', () => {
    it('prefers the model slug over cli-config parameters', () => {
      const result = effortFromCursorConfig('glm-5.2-max', '/nonexistent-config.json')
      expect(result).toEqual({ value: 'max', source: 'measured' })
    })
  })
}
