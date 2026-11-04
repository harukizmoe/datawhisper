// TS 提示词移植版与真实 Python（agent/prompts.py）的一致性。
// 用例来自 scripts/golden/export_prompts.py -> test/golden/prompts.json。
import { describe, expect, test } from 'bun:test'
import golden from './golden/prompts.json' with { type: 'json' }
import {
  ANALYZE_GUIDE,
  BROWSER_RULES,
  CHART_IDS,
  CHART_RULES,
  COMMAND_HINTS,
  CORE_RULES,
  DATA_RULES,
  DIAGRAM_RULES,
  HOOKS_RULES,
  INGEST_RULES,
  KNOWLEDGE_RULES,
  MULTI_SOURCE_RULES,
  OUTPUT_RULES,
  SKILL_CATALOG_RULES,
  TEAMS_RULES,
  TEMP_PROMPT_MAX_CHARS,
  UNNAMED_COLUMN_RULES,
  WORKSPACE_RULES,
  buildTempPromptSection,
  getSystemPrompt,
  messageNeedsBrowserRules,
  messageNeedsChartRules,
  messageNeedsDiagramRules,
  messageNeedsHooksRules,
  messageNeedsIngestRules,
  messageNeedsKnowledge,
  messageNeedsWorkspaceRules,
  schemaHasUnnamedColumns,
  stripTempPromptThinking,
} from '../src/agent/prompts.ts'

const show = (s: string | null) => JSON.stringify(s)?.slice(0, 80)

describe('static blocks', () => {
  const ts: Record<string, string> = {
    CORE_RULES, DATA_RULES, WORKSPACE_RULES, KNOWLEDGE_RULES, CHART_RULES, OUTPUT_RULES, TEAMS_RULES,
    HOOKS_RULES, BROWSER_RULES, INGEST_RULES, MULTI_SOURCE_RULES, UNNAMED_COLUMN_RULES, DIAGRAM_RULES,
    SKILL_CATALOG_RULES, _ANALYZE_GUIDE: ANALYZE_GUIDE, _CHART_IDS: CHART_IDS,
  }
  test('block count matches Python', () => {
    expect(Object.keys(ts).sort()).toEqual(Object.keys(golden.blocks).sort())
  })
  for (const [name, text] of Object.entries(golden.blocks)) {
    test(name, () => expect(ts[name]).toBe(text))
  }
  test('COMMAND_HINTS: same keys in the same order, same text', () => {
    expect(Object.keys(COMMAND_HINTS)).toEqual(Object.keys(golden.commandHints))
    expect(COMMAND_HINTS).toEqual(golden.commandHints)
  })
  test('TEMP_PROMPT_MAX_CHARS', () => expect(TEMP_PROMPT_MAX_CHARS).toBe(golden.tempPromptMaxChars))
})

describe('getSystemPrompt', () => {
  for (const [i, c] of golden.contexts.entries()) {
    test(`#${i} ${JSON.stringify(c.context)}`, () => {
      expect(getSystemPrompt(c.context)).toBe(c.prompt)
    })
  }
  test('omitted argument', () => expect(getSystemPrompt()).toBe(golden.contexts.find((c) => c.context === null)!.prompt))
})

describe('intent matchers', () => {
  const matchers = [
    ['workspace', (m: string) => messageNeedsWorkspaceRules(m)],
    ['workspaceWithWorkspace', (m: string) => messageNeedsWorkspaceRules(m, { hasWorkspace: true })],
    ['hooks', messageNeedsHooksRules],
    ['browser', messageNeedsBrowserRules],
    ['ingest', messageNeedsIngestRules],
    ['chart', messageNeedsChartRules],
    ['diagram', (m: string) => messageNeedsDiagramRules(m)],
    ['diagramWithCanvas', (m: string) => messageNeedsDiagramRules(m, { hasCanvasSkill: true })],
    ['knowledge', messageNeedsKnowledge],
  ] as const
  for (const [name, fn] of matchers) {
    test(name, () => {
      const wrong = golden.matchers
        .filter((c) => fn(c.message) !== c[name])
        .map((c) => `${show(c.message)}: python=${c[name]} ts=${!c[name]}`)
      expect(wrong).toEqual([])
      expect(golden.matchers.length).toBeGreaterThanOrEqual(60)
    })
  }
  test('null/undefined messages behave like the empty string', () => {
    for (const fn of [messageNeedsHooksRules, messageNeedsBrowserRules, messageNeedsIngestRules, messageNeedsChartRules, messageNeedsKnowledge]) {
      expect(fn(null)).toBe(false)
      expect(fn(undefined)).toBe(false)
    }
  })
})

describe('schemaHasUnnamedColumns', () => {
  test('all cases', () => {
    const wrong = golden.schemas
      .filter((c) => schemaHasUnnamedColumns(c.schema) !== c.unnamed)
      .map((c) => `${show(c.schema)}: python=${c.unnamed}`)
    expect(wrong).toEqual([])
  })
})

describe('temp prompt', () => {
  for (const [i, c] of golden.tempPrompts.entries()) {
    const label = `#${i} ${show(c.input)}`
    test(`strip ${label}`, () => expect(stripTempPromptThinking(c.input)).toBe(c.stripped))
    test(`section ${label}`, () => expect(buildTempPromptSection(c.input)).toBe(c.section))
  }
})
