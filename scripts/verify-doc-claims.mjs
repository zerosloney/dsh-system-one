/**
 * verify-doc-claims.mjs — 校验「文档里声明的数字」与「仓库实际状态」一致。
 *
 * 为什么要这个脚本：README / 文档里写着的"XXX 项测试""N 个 lib 文件"这类数字，
 * 每次加测试或加模块都会过期，而人工回头同步**必然**会漏（本项目就漏过 4 处）。
 * 与其靠自觉，不如让 CI 在漂移时报错。
 *
 * 单一真源原则：数字只从**实际运行结果**与**文件系统**取，然后与文档声明比对；
 * 不从文档之间互相比对（那只是把错误相互印证）。
 *
 * 用法：
 *   node scripts/verify-doc-claims.mjs           # 校验，不一致则退出码 1
 *   node scripts/verify-doc-claims.mjs --update  # 把文档里的数字改写成实际值
 *
 * 设计取舍：
 *   - 只校验"有明确声明位点"的数字（README 的 `npm run test # N 项测试` 与
 *     `N 个 lib/*.js`），不做全文模糊匹配——模糊匹配会误伤历史引用与行号引用；
 *   - 测试数从 TAP 报告的 `# pass N` 取，它是 runner 的权威输出；
 *   - 脚本自身零依赖，用 node:child_process 起一次测试进程。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = join(ROOT, 'README.md')
const UPDATE = process.argv.includes('--update')

/** README 里测试数与 lib 文件数的声明位点（正则必须各命中恰好一次）。 */
const CLAIMS = [
  {
    id: 'test-count',
    file: README,
    pattern: /npm run test\s+#\s*(\d+)\s*项测试/g,
    label: 'README：测试项数',
  },
  {
    id: 'lib-count',
    file: README,
    pattern: /npm run check\s+#\s*(\d+)\s*个\s*lib\/\*\.js 语法检查通过/g,
    label: 'README：lib 语法检查文件数',
  },
]

/** 数 lib/ 下的 .js 文件（与 package.json 的 check 脚本同一口径）。 */
function actualLibCount() {
  try {
    return readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).length
  } catch {
    return null
  }
}

/** 跑一次测试，从 TAP 报告里取权威的通过数。 */
function actualTestCount() {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  )
  const out = `${result.stdout || ''}\n${result.stderr || ''}`
  const pass = /^# pass (\d+)$/m.exec(out)
  const fail = /^# fail (\d+)$/m.exec(out)
  if (!pass) {
    console.error('verify-doc-claims: 无法从 TAP 输出解析 `# pass N`；测试可能没跑起来。')
    console.error(out.split('\n').slice(-15).join('\n'))
    process.exit(2)
  }
  return { pass: Number(pass[1]), fail: fail ? Number(fail[1]) : 0, status: result.status }
}

const actual = {
  'test-count': () => actualTestCount().pass,
  'lib-count': () => actualLibCount(),
}

const { pass: testPass, fail: testFail, status } = actualTestCount()
if (testFail > 0 || (status !== 0 && testFail === 0)) {
  console.error(`verify-doc-claims: 测试本身未全绿（pass=${testPass} fail=${testFail} exit=${status}），先修测试再校验文档。`)
  process.exit(2)
}

let problems = 0
let rewritten = 0

for (const claim of CLAIMS) {
  let text
  try {
    text = readFileSync(claim.file, 'utf8')
  } catch (error) {
    console.error(`verify-doc-claims: 读不到 ${relative(ROOT, claim.file)}：${error.message}`)
    problems += 1
    continue
  }

  const matches = [...text.matchAll(claim.pattern)]
  if (matches.length !== 1) {
    console.error(
      `verify-doc-claims: ${claim.label} 的声明位点应恰好出现 1 次，实际 ${matches.length} 次`
      + `（正则 ${claim.pattern}）。位点消失或重复都会让校验失去意义。`,
    )
    problems += 1
    continue
  }

  const declared = Number(matches[0][1])
  const truth = actual[claim.id]()
  if (truth === null || truth === undefined || !Number.isFinite(truth)) {
    console.error(`verify-doc-claims: 无法取得 ${claim.label} 的实际值。`)
    problems += 1
    continue
  }

  if (declared === truth) {
    console.log(`  ✓ ${claim.label}：${declared}（一致）`)
    continue
  }

  if (UPDATE) {
    // 只替换捕获组那一处数字，其余文本原样保留
    const start = matches[0].index + matches[0][0].indexOf(matches[0][1])
    const next = text.slice(0, start) + String(truth) + text.slice(start + matches[0][1].length)
    writeFileSync(claim.file, next, 'utf8')
    console.log(`  ↻ ${claim.label}：${declared} → ${truth}（已改写 ${relative(ROOT, claim.file)}）`)
    rewritten += 1
    continue
  }

  console.error(`  ✖ ${claim.label}：文档写 ${declared}，实际 ${truth}`)
  problems += 1
}

if (UPDATE) {
  console.log(`verify-doc-claims: 已更新 ${rewritten} 处声明（测试数 ${testPass}）。`)
  process.exit(0)
}

if (problems > 0) {
  console.error(
    `\nverify-doc-claims: ${problems} 处不一致。`
    + '\n运行 `npm run fix:docs` 自动改写，或手工同步后重试。',
  )
  process.exit(1)
}

console.log(`verify-doc-claims: 全部声明与实际一致（测试 ${testPass} 项）。`)
