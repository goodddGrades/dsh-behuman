/**
 * Free content scan over the turn that just ended.
 *
 * These are **hints, not triggers**. The only thing that decides whether the
 * background reviewer runs is the tool-call counter in `review.ts`; the clues
 * below are handed to that reviewer so it knows where to look. Presenting a
 * signal as a trigger would buy nothing — the periodic review runs anyway —
 * and would cost a model call every time a keyword appeared.
 *
 * The bias is deliberately loose. A false clue wastes a few lines of prompt; a
 * missed one means the reviewer scrolls past the very thing it was invoked
 * for. In particular the 结构化 clues (repeat error, tool activity) cost
 * nothing and cannot be wrong, so they carry most of the value.
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One observation about the recent turn, addressed to the reviewer. */
export interface Clue {
  /** Short stable tag, e.g. `重复报错`. */
  readonly tag: string
  /** What was observed, phrased as a hint the reviewer can act on or ignore. */
  readonly note: string
}

/**
 * Phrase tables. Matched as plain substrings against user text — no
 * segmentation, because a substring test needs none and the cost of a miss
 * here is only that one hint goes unmentioned.
 */
const PHRASES = {
  纠正: ['不对', '不是这样', '我说的是', '别用', '不要再', '重来', '换个方式', '太啰嗦', '看不懂', '错了'],
  长期指令: ['以后都', '记住', '我们项目', '下次', '每次', '永远', '一律', '统一'],
  决定: ['就用', '定了', '不改了', '按这个来', '执行吧'],
  确认: ['对了', '就是这样', '可以了', '好了', '没问题', '跑通了', '成功了'],
} as const

/** Longest tool-result text folded into an error signature. */
const SIGNATURE_WINDOW = 120

/**
 * Count tool calls committed after `sinceSeq`. This is the entire trigger for
 * the background pass: a plain count, no content inspection. Content signals
 * deliberately decide nothing — the pass runs on a schedule anyway, so a
 * keyword could only ever add a call, never remove one.
 * @param events - the session's committed events.
 * @param sinceSeq - last consumed sequence number.
 * @returns how many tool calls happened in the window.
 */
export function countToolCalls(events: readonly SessionEvent[], sinceSeq: number): number {
  let count = 0
  for (const event of events) {
    if (event.seq <= sinceSeq) continue
    if (event.type === 'tool/call') count++
  }
  return count
}

/** Longest rendered transcript handed to the reviewer. */
const TRANSCRIPT_BUDGET = 12_000

/**
 * Render the reviewed window as a compact transcript.
 *
 * A `spawn` child starts with an empty conversation, so the window has to
 * travel in the prompt. Only the tail is kept when the window overflows: the
 * most recent activity is what a reviewer is judging, and the checkpoint means
 * everything before it was already reviewed once.
 *
 * @param events - the session's committed events.
 * @param sinceSeq - last already-reviewed sequence number.
 * @returns one line per event, oldest first, trimmed to the budget.
 */
export function renderWindow(events: readonly SessionEvent[], sinceSeq: number): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.seq <= sinceSeq) continue
    const data = event.data as { content?: unknown; source?: { kind?: unknown }; name?: unknown; value?: unknown }
    if (event.type === 'user/message') {
      if (data.source?.kind !== 'user') continue
      const text = textOf(data.content).trim()
      if (text.length > 0) lines.push(`[用户] ${text}`)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(data.content).trim()
      if (text.length > 0) lines.push(`[助手] ${text.slice(0, 2000)}`)
      continue
    }
    if (event.type === 'tool/call') {
      lines.push(`[工具] ${typeof data.name === 'string' ? data.name : 'unknown'}`)
      continue
    }
    if (event.type === 'tool/result') {
      const rendered = textOf(data.content) || JSON.stringify(data.value ?? '')
      const failed = (event.data as { isError?: unknown }).isError === true
      lines.push(`[结果${failed ? '·失败' : ''}] ${rendered.slice(0, 800)}`)
    }
  }
  const joined = lines.join('\n')
  if (joined.length <= TRANSCRIPT_BUDGET) return joined
  return `…（前 ${joined.length - TRANSCRIPT_BUDGET} 字符已省略）\n${joined.slice(-TRANSCRIPT_BUDGET)}`
}

/** Text blocks of one message-like payload, or `''` when the shape is unfamiliar. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(block => (
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    ))
    .join('\n')
}

/**
 * A coarse fingerprint for "the same failure again". Deliberately crude: the
 * point is to notice a repeat, not to classify errors, so the first
 * {@link SIGNATURE_WINDOW} characters of a serialized result are enough.
 */
function errorSignature(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data as { isError?: unknown; content?: unknown; value?: unknown }
  const failed = data.isError === true
  const rendered = textOf(data.content) || (typeof data.value === 'string' ? data.value : '')
  const haystack = rendered.length > 0 ? rendered : JSON.stringify(data.value ?? data.content ?? '')
  const looksLikeError = failed || /\b(error|failed|exception|ENOENT|EACCES|command not found|报错|失败)\b/iu.test(haystack)
  if (!looksLikeError) return undefined
  return haystack.slice(0, SIGNATURE_WINDOW)
}

/**
 * Scan events after `sinceSeq` for hints worth handing to the reviewer.
 * @param events - the session's committed events.
 * @param sinceSeq - last already-reviewed sequence number.
 * @returns the clues, most structural first, deduplicated by tag.
 */
export function scanClues(events: readonly SessionEvent[], sinceSeq: number): Clue[] {
  const clues: Clue[] = []
  const seenTags = new Set<string>()
  const signatures = new Map<string, number>()
  const hits = new Map<keyof typeof PHRASES, string[]>()
  let toolCalls = 0

  const add = (clue: Clue): void => {
    if (seenTags.has(clue.tag)) return
    seenTags.add(clue.tag)
    clues.push(clue)
  }

  for (const event of events) {
    if (event.seq <= sinceSeq) continue

    if (event.type === 'tool/call') {
      toolCalls++
      continue
    }

    const signature = errorSignature(event)
    if (signature !== undefined) {
      signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
      continue
    }

    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: unknown } }).source
    if (source?.kind !== 'user') continue
    const text = textOf((event.data as { content?: unknown }).content)
    if (text.trim().length === 0) continue
    for (const [tag, phrases] of Object.entries(PHRASES) as [keyof typeof PHRASES, readonly string[]][]) {
      const matched = phrases.filter(phrase => text.includes(phrase))
      if (matched.length === 0) continue
      const existing = hits.get(tag) ?? []
      existing.push(...matched)
      hits.set(tag, existing)
    }
  }

  for (const [signature, count] of signatures) {
    if (count < 2) continue
    add({ tag: '重复报错', note: `同一段失败信息在本轮出现了 ${count} 次：「${signature.slice(0, 60)}…」——如果它后来被解决了，解决路径值得写成技能。` })
    break
  }
  if (toolCalls >= 5) {
    add({ tag: '复杂任务', note: `本轮有 ${toolCalls} 次工具调用——如果任务已经完成，做法可能值得写成技能。` })
  }
  for (const [tag, matched] of hits) {
    const unique = [...new Set(matched)].slice(0, 6).join('、')
    add({ tag, note: `用户的话里出现了「${unique}」——可能是在${tag === '纠正' ? '纠正你的做法' : tag === '长期指令' ? '下跨会话的规矩' : tag === '决定' ? '做一个决定' : '确认某件事成功了'}。` })
  }
  // No "nothing happened" guard: every `add` above is already conditional, so
  // a silent window yields an empty array on its own. An earlier version
  // returned early when the window held no user messages and no tool calls,
  // which silently dropped the repeat-error clue — a window of nothing but
  // failing tool results is exactly when that clue matters most.
  return clues
}
