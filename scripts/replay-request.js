#!/usr/bin/env node
/**
 * 从 KV 读取保存的请求并生成模拟请求代码
 *
 * 用法:
 *   node scripts/replay-request.js list              # 列出所有请求
 *   node scripts/replay-request.js get <key>         # 查看某个请求详情
 *   node scripts/replay-request.js curl <key>        # 生成 curl 命令
 *   node scripts/replay-request.js fetch <key>       # 生成 Node.js fetch 代码
 *   node scripts/replay-request.js replay <key>      # 直接重放请求
 */

const { execSync } = require('child_process')

const KV_NAMESPACE_ID = 'd325ef9e98a8490b88ed3ea24004b7ef'

function runWrangler(args) {
  try {
    const result = execSync(`npx wrangler ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return result
  } catch (e) {
    console.error('Wrangler 命令失败:', e.message)
    process.exit(1)
  }
}

function listRequests() {
  const output = runWrangler(`kv:key list --namespace-id=${KV_NAMESPACE_ID}`)
  const keys = JSON.parse(output)

  const requests = keys.filter(k => k.name.startsWith('request:'))

  console.log(`\n📋 找到 ${requests.length} 个请求记录\n`)

  if (requests.length > 0) {
    requests.slice(0, 30).forEach(k => {
      const timestamp = parseInt(k.name.split(':')[1])
      const date = new Date(timestamp).toLocaleString('zh-CN')
      console.log(`  ${k.name}`)
      console.log(`    时间: ${date}`)
    })
    if (requests.length > 30) {
      console.log(`\n  ... 还有 ${requests.length - 30} 个请求`)
    }
  }

  console.log('\n提示: 使用 "node scripts/replay-request.js curl <key>" 生成 curl 命令')
}

function getRequest(key) {
  const output = runWrangler(`kv:key get "${key}" --namespace-id=${KV_NAMESPACE_ID}`)
  return JSON.parse(output)
}

function showRequest(key) {
  const data = getRequest(key)
  console.log('\n📦 请求详情:\n')
  console.log(JSON.stringify(data, null, 2))
}

function generateCurl(key) {
  const data = getRequest(key)

  let curl = `curl -X ${data.method} '${data.url}'`

  // 添加 headers
  if (data.headers) {
    for (const [name, value] of Object.entries(data.headers)) {
      // 跳过一些自动添加的 headers
      if (['host', 'content-length', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-real-ip', 'cdn-loop', 'cf-worker'].includes(name.toLowerCase())) {
        continue
      }
      curl += ` \\\n  -H '${name}: ${value.replace(/'/g, "'\\''")}'`
    }
  }

  // 添加 body
  if (data.body) {
    const bodyStr = typeof data.body === 'object' ? JSON.stringify(data.body) : data.body
    curl += ` \\\n  -d '${bodyStr.replace(/'/g, "'\\''")}'`
  }

  console.log('\n🔧 生成的 curl 命令:\n')
  console.log(curl)
  console.log('\n')
}

function generateFetch(key) {
  const data = getRequest(key)

  // 过滤 headers
  const headers = {}
  if (data.headers) {
    for (const [name, value] of Object.entries(data.headers)) {
      if (!['host', 'content-length', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-real-ip', 'cdn-loop', 'cf-worker'].includes(name.toLowerCase())) {
        headers[name] = value
      }
    }
  }

  const code = `
const response = await fetch('${data.url}', {
  method: '${data.method}',
  headers: ${JSON.stringify(headers, null, 4)},
  body: ${data.body ? JSON.stringify(JSON.stringify(data.body)) : 'undefined'}
});

const result = await response.json();
console.log(result);
`

  console.log('\n🔧 生成的 Node.js fetch 代码:\n')
  console.log(code)
}

async function replayRequest(key) {
  const data = getRequest(key)

  console.log(`\n🚀 重放请求: ${data.method} ${data.url}\n`)

  // 过滤 headers
  const headers = {}
  if (data.headers) {
    for (const [name, value] of Object.entries(data.headers)) {
      if (!['host', 'content-length', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-real-ip', 'cdn-loop', 'cf-worker'].includes(name.toLowerCase())) {
        headers[name] = value
      }
    }
  }

  try {
    const response = await fetch(data.url, {
      method: data.method,
      headers,
      body: data.body ? JSON.stringify(data.body) : undefined
    })

    console.log(`状态码: ${response.status}`)
    console.log('响应头:', Object.fromEntries(response.headers.entries()))

    const text = await response.text()
    try {
      console.log('响应体:', JSON.stringify(JSON.parse(text), null, 2))
    } catch {
      console.log('响应体:', text.substring(0, 2000))
    }
  } catch (e) {
    console.error('请求失败:', e.message)
  }
}

// 主程序
const [,, command, key] = process.argv

switch (command) {
  case 'list':
    listRequests()
    break
  case 'get':
    if (!key) {
      console.error('请提供 key 参数')
      process.exit(1)
    }
    showRequest(key)
    break
  case 'curl':
    if (!key) {
      console.error('请提供 key 参数')
      process.exit(1)
    }
    generateCurl(key)
    break
  case 'fetch':
    if (!key) {
      console.error('请提供 key 参数')
      process.exit(1)
    }
    generateFetch(key)
    break
  case 'replay':
    if (!key) {
      console.error('请提供 key 参数')
      process.exit(1)
    }
    replayRequest(key)
    break
  default:
    console.log(`
📝 请求重放工具

用法:
  node scripts/replay-request.js list              列出所有保存的请求
  node scripts/replay-request.js get <key>         查看某个请求详情
  node scripts/replay-request.js curl <key>        生成 curl 命令
  node scripts/replay-request.js fetch <key>       生成 Node.js fetch 代码
  node scripts/replay-request.js replay <key>      直接重放请求
`)
}
