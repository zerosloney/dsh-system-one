/**
 * probe-host.mjs — 接缝探针：对着**真实宿主 dsh** 验证本插件的安装与接线。
 *
 * 为什么需要它：本插件挂在宿主内部事件名与 loader 契约上，宿主一漂移就静默失效；
 * 单元测试全部跑在 mock ctx 上，照不出接缝处的断裂。生态里被验证过的两条教训
 * （docs/dsh-systemone-ecosystem.md 坑 1 / 坑 4）都能被这里拦住：
 *
 *   坑 1 · duplicate loader entry id —— 手写过 insert 行的 profile 再跑
 *          `dsh plugin add`，两处注册同一 id 会让**整份 profile 起不来**；
 *   坑 4 · patch 覆盖是整份替换 —— 字段级覆盖会清掉该 row 其余配置。
 *
 * 探测流程（全部在一个一次性的临时 DSH_HOME 里，不碰真实 profile）：
 *   1. npm pack 出当前工作区的 tarball（探的就是工作区，不是 npm 上的旧版）；
 *   2. `dsh <profile> --from-default-profile headless --dump-config` 初始化 profile
 *      （不用 plugin add 的自动初始化：那只会给裸 dsh-base 常驻栈，headless 模板
 *        才多拉一个 app bundle，组合路径更接近真实使用）；
 *   3. `dsh plugin --profile <profile> add <tarball>` 真装一次；
 *   4. `dsh --profile <profile> --dump-config` 断言 `- id: systemone` 恰好 1 行。
 *
 * 明确不探的：headless 真启动。它需要 DEEPSEEK_API_KEY，且插件激活日志不落在
 * 可观测的 stdout（进 zstd 压缩的 session 日志），CI 里既没凭证也没有可靠判据——
 * 真启动验证在有凭证的环境里人工做。
 *
 * 用法：
 *   npm run probe                        # 通过则退出码 0，临时目录自动清理
 *   node scripts/probe-host.mjs --keep   # 保留临时 DSH_HOME 便于调试（路径会打印）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const KEEP = process.argv.includes('--keep')
const PROFILE = 'seam-probe'
const STEP_TIMEOUT_MS = 180_000

/** win32 上全局 dsh/npm 是 .cmd shim，必须经 shell 起进程；参数含空格时手动加引号。 */
function run(command, args, { timeout = STEP_TIMEOUT_MS } = {}) {
  const quoted = process.platform === 'win32' ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
  const result = spawnSync(command, quoted, {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout,
    env: { ...process.env, DSH_HOME: home },
  })
  const timedOut = result.error?.code === 'ETIMEDOUT'
  return {
    ok: result.status === 0 && !timedOut,
    output: `${result.stdout || ''}${result.stderr || ''}`,
    label: timedOut ? `超时（>${timeout}ms）` : `退出码 ${result.status}`,
  }
}

let home = ''
const steps = []
function step(name, fn) {
  process.stdout.write(`→ ${name} ... `)
  try {
    const note = fn()
    steps.push([name, true])
    console.log(`ok${note ? `（${note}）` : ''}`)
    return true
  } catch (error) {
    steps.push([name, false])
    console.log(`失败\n    ${String(error.message || error).split('\n').join('\n    ')}`)
    return false
  }
}

home = mkdtempSync(join(tmpdir(), 'dsh-systemone-probe-'))
let failed = false

failed ||= !step(`初始化临时 DSH_HOME：${home}`, () => {})

failed ||= !step(`宿主版本确认（dsh --version）`, () => {
  const r = run('dsh', ['--version'])
  if (!r.ok) throw new Error(`dsh 不在 PATH 上（${r.label}）`)
  return r.output.trim().split('\n')[0]
})

let tarball = ''
failed ||= !step('npm pack 当前工作区', () => {
  const r = run('npm', ['pack', '--pack-destination', home])
  if (!r.ok) throw new Error(`npm pack 失败（${r.label}）：\n${r.output.slice(-500)}`)
  tarball = readdirSync(home).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error(`pack 输出里没有 .tgz：${readdirSync(home).join('、')}`)
  return tarball
})

failed ||= !step(`从 headless 模板初始化 profile "${PROFILE}"`, () => {
  const r = run('dsh', [PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  if (!r.ok) throw new Error(`初始化失败（${r.label}）：\n${r.output.slice(-500)}`)
})

failed ||= !step(`dsh plugin --profile ${PROFILE} add <tarball>`, () => {
  const r = run('dsh', ['plugin', '--profile', PROFILE, 'add', join(home, tarball)])
  if (!r.ok) throw new Error(`安装失败（${r.label}）：\n${r.output.slice(-500)}`)
})

failed ||= !step(`dump-config 断言：- id: systemone 恰好 1 行`, () => {
  const r = run('dsh', ['--profile', PROFILE, '--dump-config'])
  if (!r.ok) throw new Error(`dump-config 失败（${r.label}）：\n${r.output.slice(-500)}`)
  const lines = r.output.split('\n').filter((line) => /- id: systemone\s*$/.test(line.trimEnd()) || line.trim() === 'id: systemone')
  if (lines.length !== 1) {
    throw new Error(`期望恰好 1 条 id: systemone，实际 ${lines.length} 条${lines.length ? '：\n' + lines.join('\n') : ''}`
      + `${lines.length === 0 ? '\n（0 条通常意味着插件没被组合进 profile 树——检查 dsh.profile.bundles 与 patch 层）' : '\n（>1 条即 duplicate loader entry id，整份 profile 会起不来）'}`)
  }
})

if (failed || KEEP) {
  console.log(`\n临时 DSH_HOME 保留在 ${home}（可手动排查后删除）`)
} else {
  rmSync(home, { recursive: true, force: true })
}

console.log(failed ? '\n接缝探针：FAIL' : '\n接缝探针：PASS（安装 + 组合 + 唯一注册 全部通过）')
process.exit(failed ? 1 : 0)
