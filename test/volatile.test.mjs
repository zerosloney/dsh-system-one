/**
 * volatile.test.mjs — 配置读取辅助（lib/volatile.js）的行为测试。
 *
 * 重点锚定：readNumber 对空字符串的兜底必须与 readString 一致（空值回退到默认值），
 * 否则 autoTimeoutMs 等字段被写成空字符串时会静默变成 0、禁用硬超时。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readBoolean, readNumber, readString } from '../lib/volatile.js'

test('readNumber：空字符串回退到默认值，与 readString 语义一致', () => {
  assert.equal(readNumber({ autoMinChars: '' }, 'autoMinChars', 4), 4)
  assert.equal(readNumber({ autoTimeoutMs: '' }, 'autoTimeoutMs', 8000), 8000)
  assert.equal(readNumber({ autoMinChars: '5' }, 'autoMinChars', 4), 5)
  assert.equal(readNumber({ autoMinChars: 0 }, 'autoMinChars', 4), 0, '合法数值 0 不应被兜底')
  assert.equal(readNumber({}, 'autoMinChars', 4), 4)
})

test('readString：空字符串回退到默认值', () => {
  assert.equal(readString({ model: '' }, 'model', 'u2-decision'), 'u2-decision')
  assert.equal(readString({ model: 'other' }, 'model', 'u2-decision'), 'other')
  assert.equal(readString({}, 'model', 'u2-decision'), 'u2-decision')
})

test('readBoolean：非 volatile 布尔原样返回', () => {
  assert.equal(readBoolean({ autoDecide: true }, 'autoDecide', false), true)
  assert.equal(readBoolean({}, 'autoDecide', false), false)
})