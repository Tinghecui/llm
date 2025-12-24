#!/usr/bin/env node
const { execSync } = require('child_process')

const KV_NAMESPACE_ID = 'd325ef9e98a8490b88ed3ea24004b7ef'

// 获取所有 error keys
const output = execSync(`npx wrangler kv:key list --namespace-id=${KV_NAMESPACE_ID}`, { encoding: 'utf-8' })
const keys = JSON.parse(output)
const errorKeys = keys.filter(k => k.name.startsWith('error'))

console.log(`找到 ${errorKeys.length} 个错误记录，开始删除...`)

let deleted = 0
for (const k of errorKeys) {
  try {
    execSync(`npx wrangler kv:key delete "${k.name}" --namespace-id=${KV_NAMESPACE_ID} -f`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    })
    deleted++
    if (deleted % 50 === 0) {
      console.log(`已删除 ${deleted}/${errorKeys.length}`)
    }
  } catch (e) {
    console.log(`删除失败: ${k.name}`)
  }
}

console.log(`\n完成! 共删除 ${deleted} 个错误记录`)
