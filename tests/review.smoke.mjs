/**
 * Smoke test for the dependency-free logic added in v2: the clue scan, the
 * tool-call counter, and the skill-name gate.
 *
 *   node --experimental-strip-types tests/review.smoke.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countToolCalls, scanClues } from '../src/clues.ts'
import { rejectSkillName, writeSkill } from '../src/skills.ts'

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
}

/** A committed session event of the shape the scan reads. */
const userMessage = (seq, text) => ({
  type: 'user/message',
  seq,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const toolCall = seq => ({ type: 'tool/call', seq, data: {} })
const toolError = (seq, text) => ({ type: 'tool/result', seq, data: { isError: true, content: [{ type: 'text', text }] } })

console.log('— 工具调用计数（触发器）—')
check('数窗口内的 tool/call', countToolCalls([toolCall(1), toolCall(2), toolCall(3)], -1), 3)
check('只数检查点之后的', countToolCalls([toolCall(1), toolCall(2), toolCall(3)], 1), 2)
check('非工具事件不计', countToolCalls([userMessage(1, '你好'), toolCall(2)], -1), 1)
check('空会话为 0', countToolCalls([], -1), 0)

console.log('\n— 线索扫描（只是提示，不是触发器）—')
const clues = scanClues([
  userMessage(1, '不对，别用表情符号'),
  userMessage(2, '以后都按这个来'),
  toolCall(3), toolCall(4), toolCall(5), toolCall(6), toolCall(7),
], -1)
const tags = clues.map(c => c.tag)
check('抓到「纠正」', tags.includes('纠正'), true)
check('抓到「长期指令」', tags.includes('长期指令'), true)
check('抓到「复杂任务」', tags.includes('复杂任务'), true)

const repeat = scanClues([
  toolError(1, 'Error: ECONNREFUSED 127.0.0.1:5432'),
  toolError(2, 'Error: ECONNREFUSED 127.0.0.1:5432'),
], -1)
check('重复报错被抓到', repeat.some(c => c.tag === '重复报错'), true)

const once = scanClues([toolError(1, 'Error: ENOENT no such file')], -1)
check('只出现一次不报「重复」', once.some(c => c.tag === '重复报错'), false)

console.log('\n— 静默轮次不产生线索 —')
check('没有用户消息、没有工具调用 → 空', scanClues([], -1).length, 0)

console.log('\n— 技能命名红线 —')
check('类级别名字放行', rejectSkillName('pdf-table-extraction'), undefined)
check('fix- 前缀被拒', typeof rejectSkillName('fix-login-bug'), 'string')
check('debug- 被拒', typeof rejectSkillName('debug-redis-timeout'), 'string')
check('带 PR 号被拒', typeof rejectSkillName('pr-1234-cleanup'), 'string')
check('带 issue 号被拒', typeof rejectSkillName('issue-42-retry'), 'string')
check('名字里含数字被拒', typeof rejectSkillName('retry-v2'), 'string')

console.log('\n— 技能落盘 —')
const skillsDir = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
const first = writeSkill(skillsDir, { name: 'pdf-table-extraction', description: '从 PDF 抽表格', content: '先 pdftotext，再按行切。' })
check('新技能写入成功', first.ok, true)
check('SKILL.md 落盘', existsSync(join(skillsDir, 'pdf-table-extraction', 'SKILL.md')), true)
const body = readFileSync(join(skillsDir, 'pdf-table-extraction', 'SKILL.md'), 'utf8')
check('frontmatter 有 name', body.includes('name: pdf-table-extraction'), true)
check('frontmatter 有 description', body.includes('description: 从 PDF 抽表格'), true)

const again = writeSkill(skillsDir, { name: 'pdf-table-extraction', description: '改一版', content: '不同内容' })
check('同名不覆盖（交给主 agent 更新）', again.ok, false)
check('拒绝理由提到已有同名', again.ok === false && again.reason.includes('同名'), true)

const bad = writeSkill(skillsDir, { name: 'fix-2026-09-20-thing', description: 'x', content: 'y' })
check('踩红线的技能写不进去', bad.ok, false)

const empty = writeSkill(skillsDir, { name: 'valid-name', description: 'x', content: '   ' })
check('空正文被拒', empty.ok, false)

rmSync(skillsDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
