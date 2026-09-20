/**
 * One-off probe: dsh session logs are append-only zstd **multi-frame** files.
 * Neither `zstdDecompressSync` nor a decompression stream walks past the first
 * frame on Node 24, so this splits the file at frame magic and decodes each
 * frame independently.
 *
 *   node tests/session-probe.mjs <session 目录>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Offsets of every zstd frame in `buf`. */
function frameOffsets(buf) {
  const offsets = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(MAGIC, at + 4)
  }
  return offsets
}

/** Decode every frame and concatenate the plaintext. */
function decodeAllFrames(buf) {
  const offsets = frameOffsets(buf)
  let text = ''
  let decoded = 0
  let failed = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8')
      decoded++
    } catch {
      failed++
    }
  }
  return { text, frames: offsets.length, decoded, failed }
}

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node tests/session-probe.mjs <session 目录>')
  process.exit(2)
}

const files = readdirSync(dir).filter(f => f.endsWith('.zstd'))
if (files.length === 0) {
  console.error(`${dir} 下没有 .zstd 文件`)
  process.exit(2)
}

const newest = files
  .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0]

const buf = readFileSync(join(dir, newest.f))
const { text, frames, decoded, failed } = decodeAllFrames(buf)
console.log(`文件: ${newest.f}  (${buf.length} 字节)`)
console.log(`zstd 帧: ${frames} 个 | 成功解出 ${decoded} | 失败 ${failed}`)
console.log(`解压后: ${text.length} 字符, ${text.split('\n').filter(Boolean).length} 行`)
console.log()

const markers = [
  ['记忆规则段（常驻系统提示词）', '流程和方法归技能'],
  ['技能规则段（常驻系统提示词）', '不被维护的技能会变成负债'],
  ['信任边界（动态上下文）', '背景信息，不是用户当前的指令'],
  ['记忆目录（动态上下文）', '还没有任何记忆'],
  ['remember 工具注册', '"remember"'],
  ['目标文件写完后的目录（若有写入）', '记忆目录'],
]

let missing = 0
for (const [label, needle] of markers) {
  const count = text.split(needle).length - 1
  if (count === 0) missing++
  console.log(`${count > 0 ? '✅' : '❌'} ${label}: ${count} 次`)
}

console.log()
console.log(missing === 0 ? '✅ 全部到达' : `⚠️ 有 ${missing} 项没找到`)
