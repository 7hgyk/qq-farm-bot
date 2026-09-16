import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadLoginTabs() {
  const source = readFileSync(new URL('../src/components/account-login-tabs.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => require(id), module, module.exports)
  return module.exports
}

const { pickAvailableLoginTab } = loadLoginTabs()

const allOff = { codeLogin: false, wechatQrLogin: false, qqQrLogin: false, yybQrLogin: false }

test('default availability resolves to the yyb tab', () => {
  assert.equal(pickAvailableLoginTab({ ...allOff, yybQrLogin: true }), 'yyb_qr')
})

test('code login wins when it is enabled', () => {
  assert.equal(pickAvailableLoginTab({ ...allOff, codeLogin: true, yybQrLogin: true }), 'code')
})

test('yyb is preferred over wechat and qq when code login is off', () => {
  assert.equal(pickAvailableLoginTab({ ...allOff, yybQrLogin: true, wechatQrLogin: true, qqQrLogin: true }), 'yyb_qr')
})

test('falls back to wechat then qq when yyb is off', () => {
  assert.equal(pickAvailableLoginTab({ ...allOff, wechatQrLogin: true, qqQrLogin: true }), 'wx_qr')
  assert.equal(pickAvailableLoginTab({ ...allOff, qqQrLogin: true }), 'qq_qr')
})

test('falls back to code when every login method is disabled', () => {
  assert.equal(pickAvailableLoginTab(allOff), 'code')
})
