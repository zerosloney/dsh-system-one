/**
 * volatile.js — 配置读取辅助。
 *
 * 被 `.volatile()` 标注的 Config 字段，schemastery 会把它解析成一个「引用对象」
 * （cosmokit 的 volatile），热更新时**原地替换内部值**，插件无需重启即可生效。
 *
 * 代价是读取时必须先脱壳：直接 `config.model` 拿到的是引用对象而不是字符串。
 * 所有配置读取都应经过这里的 `unwrap()`：
 *   - 非 volatile 字段 / 单元测试里的普通对象：原样返回，行为不变；
 *   - volatile 字段：返回当前最新值，配置页保存后立即生效。
 *
 * 识别方式是 cosmokit 的全局注册符号 `Symbol.for("cosmokit.volatile.write")`
 * （见 cosmokit `createVolatile` / `isVolatile`）。用全局符号而不是 import，
 * 是为了让本插件保持零依赖：宿主里可能同时存在多份 cosmokit 副本（ESM/CJS），
 * 而全局符号在各副本间是同一个。
 */

/** cosmokit 标记 volatile 引用的全局符号。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 判断一个值是否是 volatile 引用对象。 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 取出 volatile 引用里的当前值；非 volatile 原样返回。 */
export function unwrap(value) {
  return isVolatileRef(value) ? value.get() : value
}

/** 读取字符串配置（去壳 + 空值兜底）。 */
export function readString(config, key, fallback = '') {
  const value = unwrap(config?.[key])
  if (value === undefined || value === null) return fallback
  const text = String(value)
  return text === '' ? fallback : text
}

/** 读取数值配置（去壳 + 非法值兜底）。 */
export function readNumber(config, key, fallback) {
  const value = Number(unwrap(config?.[key]))
  return Number.isFinite(value) ? value : fallback
}

/** 读取布尔配置（去壳 + 默认值兜底）。 */
export function readBoolean(config, key, fallback = false) {
  const value = unwrap(config?.[key])
  if (value === undefined || value === null) return fallback
  return Boolean(value)
}
