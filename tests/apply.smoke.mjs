/**
 * Smoke test for the reviewer's write path and the transcript renderer — the
 * half of the review loop that runs in code rather than in a subagent, and so
 * can be exercised without a subagent service.
 *
 *   node --experimental-strip-types tests/apply.smoke.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyReport } from '../src/apply.ts'
import { renderWindow } from '../src/clues.ts'
import { MemoryStore } from '../src/store.ts'

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
}

const messages = []
const logger = { info: m => messages.push(['info', m]), warn: m => messages.push(['warn', m]) }

const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'))
const skillsDir = join(root, 'skills')
const store = new MemoryStore(join(root, 'memory'))

console.log('— 复审报告 → 落盘 —')
const report = applyReport(logger, store, { skillsDir }, {
  memories: [
    {
      title: '用户偏好中文',
      content: '用户要求全程中文。',
      type: 'feedback',
      description: '全程中文，别夹英文术语',
      why: '读起来快',
      howToApply: '解释时先给中文',
    },
    { title: '缺字段', content: 'x', type: 'project' },              // 缺 description
    { title: '类型非法', content: 'x', type: 'nonsense', description: 'y' }, // type 不在白名单
  ],
  skills: [
    { name: 'pdf-table-extraction', description: '从 PDF 抽表格', content: '先 pdftotext 再按行切。' },
    { name: 'fix-login-bug', description: '修登录 bug', content: 'x' },   // 踩命名红线
  ],
  summary: '记了一条，写了一个技能',
})

check('写入 1 条记忆', report.memories, 1)
check('写入 1 个技能', report.skills, 1)
check('summary 透传', report.summary, '记了一条，写了一个技能')
check('记忆文件落盘', existsSync(join(root, 'memory', 'memories', '用户偏好中文.md')), true)
check('目录已重建', readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8').includes('全程中文，别夹英文术语'), true)
check('技能落盘', existsSync(join(skillsDir, 'pdf-table-extraction', 'SKILL.md')), true)
check('坏记忆被跳过并记 warn', messages.filter(([l]) => l === 'warn').length >= 2, true)
check('踩红线的技能被拒并记 info', messages.some(([l, m]) => l === 'info' && m.includes('fix-login-bug')), true)
check('红线技能没落盘', existsSync(join(skillsDir, 'fix-login-bug')), false)

console.log('\n— 重复复审不重复建 —')
const again = applyReport(logger, store, { skillsDir }, {
  memories: [{ title: '用户偏好中文', content: '用户要求全程中文。', type: 'feedback', description: '全程中文，别夹英文术语' }],
  skills: [{ name: 'pdf-table-extraction', description: '改一版', content: '别的' }],
  summary: '',
})
check('记忆走强化不新建', again.memories, 1)
check('记忆文件数没变', readdirSync(join(root, 'memory', 'memories')).filter(f => f.endsWith('.md')).length, 1)
check('自己写的技能可以更新', again.skills, 1)

console.log('\n— 手写的技能碰不得 —')
mkdirSync(join(skillsDir, 'hand-made'), { recursive: true })
writeFileSync(join(skillsDir, 'hand-made', 'SKILL.md'), '---\nname: hand-made\ndescription: 人手写的\n---\n\n正文\n')
const clobber = applyReport(logger, store, { skillsDir }, {
  memories: [],
  skills: [{ name: 'hand-made', description: '想覆盖', content: '不该落盘' }],
  summary: '',
})
check('手写技能没被写进去', clobber.skills, 0)
check('手写技能内容完好', readFileSync(join(skillsDir, 'hand-made', 'SKILL.md'), 'utf8').includes('人手写的'), true)

console.log('\n— 空报告 —')
const empty = applyReport(logger, store, { skillsDir }, { memories: [], skills: [], summary: '没有' })
check('什么都不写', `${empty.memories}/${empty.skills}`, '0/0')

console.log('\n— 畸形报告不崩 —')
const broken = applyReport(logger, store, { skillsDir }, {})
check('缺字段整体不崩', `${broken.memories}/${broken.skills}`, '0/0')
const notArray = applyReport(logger, store, { skillsDir }, { memories: 'nope', skills: 42, summary: 'x' })
check('字段类型错也不崩', `${notArray.memories}/${notArray.skills}`, '0/0')

console.log('\n— 对话渲染 —')
const ev = (seq, type, data) => ({ seq, type, data })
const window = renderWindow([
  ev(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我查构建流程' }] }),
  ev(2, 'tool/call', { name: 'read' }),
  ev(3, 'tool/result', { isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] }),
  ev(4, 'assistant/message', { content: [{ type: 'text', text: '我看了 package.json' }] }),
], -1)
check('渲染出用户行', window.includes('[用户] 帮我查构建流程'), true)
check('渲染出工具行', window.includes('[工具] read'), true)
check('失败结果有标记', window.includes('[结果·失败]'), true)
check('渲染出助手行', window.includes('[助手]'), true)
check('检查点之前的不渲染', renderWindow([ev(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '旧的' }] })], 1), '')
check('空窗口渲染为空', renderWindow([], -1), '')

const huge = renderWindow(
  Array.from({ length: 400 }, (_, i) => ev(i, 'assistant/message', { content: [{ type: 'text', text: 'x'.repeat(100) }] })),
  -1,
)
check('超长窗口被截断', huge.length <= 12_100, true)
check('截断保留尾部', huge.startsWith('…'), true)

rmSync(root, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
