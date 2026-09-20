/**
 * Smoke test for the dependency-free half of the plugin: slug safety, bigram
 * dedupe, and catalog regeneration. Runs on stock Node (type stripping), so it
 * verifies the store before the dsh toolchain is installed.
 *
 *   node --experimental-strip-types tests/store.smoke.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, bigramOverlap, slugify } from '../src/store.ts'

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
const store = new MemoryStore(root)

console.log('— slug 安全性 —')
check('中文标题保留为可读 slug', slugify('用户偏好中文大白话'), '用户偏好中文大白话')
check('路径穿越被消灭', slugify('../../etc/passwd'), 'etc-passwd')
check('空标题兜底', slugify('!!!'), 'memory')
check('反斜杠不残留', slugify('a\\b'), 'a-b')

console.log('\n— bigram 重合度 —')
check('相同文本 = 1', bigramOverlap('用户偏好简洁', '用户偏好简洁'), 1)
check('完全不沾边 = 0', bigramOverlap('aaaa', 'bbbb'), 0)
const near = bigramOverlap('用户偏好简洁回答', '用户偏好简洁回答，别啰嗦')
console.log(`  info  近重复重合度 = ${near.toFixed(4)}（阈值 0.82）`)

console.log('\n— 写入与目录 —')
const first = store.remember({
  title: '中文大白话',
  content: '用户要求全程中文、说人话，禁止堆项目内部变量名。',
  kind: 'feedback',
  description: '禁止堆项目内部变量名，讲机制本身',
  why: '内部词汇对理解机制没帮助',
  howToApply: '解释机制用日常类比',
})
check('首次写入 = created', first.action, 'created')
check('目录已有 1 条', first.total, 1)
check('记忆文件存在', existsSync(join(root, first.path)), true)
const catalog = readFileSync(join(root, 'MEMORY.md'), 'utf8')
check('目录里有这一行', catalog.includes('禁止堆项目内部变量名'), true)

console.log('\n— 重复即强化 —')
const again = store.remember({
  title: '中文大白话',
  content: '用户要求全程中文、说人话。',
  kind: 'feedback',
  description: '禁止堆项目内部变量名，讲机制本身',
  why: '内部词汇没帮助',
  howToApply: '用日常类比',
})
check('近重复 = reinforced（不是新建）', again.action, 'reinforced')
check('总数没有增加', again.total, 1)
check('磁盘上只有一个记忆文件', readdirSync(join(root, 'memories')).filter(f => f.endsWith('.md')).length, 1)

console.log('\n— 手删文件后目录自愈 —')
rmSync(join(root, again.path))
store.rebuildCatalog()
check('目录里那行消失了', readFileSync(join(root, 'MEMORY.md'), 'utf8').includes('禁止堆项目内部变量名'), false)
check('重建后 list 为空', store.list().length, 0)

console.log('\n— 空目录提示 —')
check('空目录给出提示语', store.renderCatalog().startsWith('（还没有任何记忆'), true)

rmSync(root, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
