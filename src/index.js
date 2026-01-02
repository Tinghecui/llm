// ============================================
// Cloudflare Worker: API 转发 + 请求日志
// ============================================

const CONFIG = {
  TARGET_HOST: "anyrouter.top",
  // Claude CLI 特征头 - 伪装成官方客户端
  INJECT_HEADERS: {
    "user-agent": "claude-cli/2.0.76 (external, cli)",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-stainless-arch": "arm64",
    "x-stainless-os": "MacOS",
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-package-version": "0.70.0",
    "x-stainless-helper-method": "stream",
    "x-stainless-timeout": "600",
    "x-stainless-retry-count": "0"
  }
}

// 把 messages 的 content 替换成 *
function summarizeMessages(messages) {
  if (!messages || !Array.isArray(messages)) return null
  return messages.map(m => ({ role: m.role, content: "*" }))
}

// 检测是否为健康检查请求（9个特征全部匹配）
function isHealthCheckRequest(body, headers) {
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return false
  }

  // === Headers 特征检查 (3个) ===
  const userAgent = headers["user-agent"] || ""
  const hasApiKey = !!headers["x-api-key"]
  const hasAuth = !!headers["authorization"]

  // 1. user-agent 包含 Go-http-client
  // 2. 有 x-api-key
  // 3. 没有 authorization
  const headerMatch =
    userAgent.includes("Go-http-client") &&
    hasApiKey &&
    !hasAuth

  if (!headerMatch) return false

  // === Body 特征检查 (6个) ===
  const messages = body.messages
  const firstMsg = messages[0]
  if (!firstMsg) return false

  // 4. messages 长度 = 1
  const hasOnlyOneMessage = messages.length === 1

  // 5. content 是字符串 "hi"（不是数组格式）
  const isStringContent = typeof firstMsg.content === "string"
  const isHiMessage = isStringContent && firstMsg.content.toLowerCase() === "hi"

  // 6. tools 是空数组
  const hasEmptyTools = Array.isArray(body.tools) && body.tools.length === 0

  // 7. 没有 stream 字段
  const noStream = !("stream" in body)

  // 8. 没有 metadata 字段
  const noMetadata = !("metadata" in body)

  // 9. 没有 system 字段
  const noSystem = !("system" in body)

  const bodyMatch =
    hasOnlyOneMessage &&
    isHiMessage &&
    hasEmptyTools &&
    noStream &&
    noMetadata &&
    noSystem

  return bodyMatch
}

// 生成模拟的 Claude API 响应
function buildMockResponse(model) {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Hi! How can I help you today?"
      }
    ],
    model: model || "claude-sonnet-4-5-20250514",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 8,
      output_tokens: 12
    }
  }
}

// 随机延迟 2-4 秒
function randomDelay() {
  const ms = 2000 + Math.random() * 2000
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 保存到 R2
async function saveToR2(env, data) {
  const date = data.timestamp.split('T')[0]
  const key = `logs/${date}/${data.request_id}.json`

  try {
    await env.LOGS_BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' }
    })
    console.log(JSON.stringify({
      type: 'R2_SAVED',
      request_id: data.request_id,
      key
    }))
  } catch (e) {
    console.log(JSON.stringify({
      type: 'R2_SAVE_ERROR',
      request_id: data.request_id,
      error: e.message
    }))
  }
}

// 合并相同类型的 content
function mergeContent(chunks) {
  const result = []
  let currentText = ''
  let currentThinking = ''

  for (const chunk of chunks) {
    if (chunk.type === 'text') {
      currentText += chunk.text
    } else if (chunk.type === 'thinking') {
      currentThinking += chunk.thinking
    }
  }

  if (currentThinking) {
    result.push({ type: 'thinking', thinking: currentThinking })
  }
  if (currentText) {
    result.push({ type: 'text', text: currentText })
  }

  return result
}

// 后台处理日志流（使用 tee() 的副本流）
async function processLogStreamInBackground(logStream, requestId, bodyContent, startTime, env) {
  let fullContent = []
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = null

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    // 读取流并解析 SSE 事件
    const reader = logStream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // 解析 SSE 事件
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const event = JSON.parse(data)

            switch (event.type) {
              case 'message_start':
                inputTokens = event.message?.usage?.input_tokens || 0
                break

              case 'content_block_delta':
                if (event.delta?.type === 'text_delta') {
                  fullContent.push({
                    type: 'text',
                    text: event.delta.text
                  })
                } else if (event.delta?.type === 'thinking_delta') {
                  fullContent.push({
                    type: 'thinking',
                    thinking: event.delta.thinking
                  })
                }
                break

              case 'message_delta':
                stopReason = event.delta?.stop_reason
                outputTokens = event.usage?.output_tokens || 0
                break
            }
          } catch {}
        }
      }
    }

    const mergedContent = mergeContent(fullContent)

    // 记录流式响应到 console.log
    console.log(JSON.stringify({
      type: "SUCCESS_RESPONSE",
      requestId,
      status: 200,
      duration: Date.now() - startTime,
      response: {
        content: mergedContent,
        stop_reason: stopReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      }
    }))

    // 保存到 R2
    await saveToR2(env, {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      latency: Date.now() - startTime,
      status: 200,
      request: {
        model: bodyContent.model,
        messages: bodyContent.messages,
        system: bodyContent.system,
        max_tokens: bodyContent.max_tokens,
        temperature: bodyContent.temperature,
        thinking: bodyContent.thinking,
        tools: bodyContent.tools,
        metadata: bodyContent.metadata,
        stream: bodyContent.stream
      },
      response: {
        content: mergedContent,
        stop_reason: stopReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      }
    })
  } catch (error) {
    console.log(JSON.stringify({
      type: 'LOG_PROCESSING_ERROR',
      request_id: requestId,
      error: error.message
    }))
  }
}

// 主入口
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // 健康检查页面
    if (url.pathname === '/health') {
      return renderHealthPage()
    }
    if (url.pathname === '/health/api') {
      return getHealthHistory(env)
    }

    const requestId = crypto.randomUUID()
    const startTime = Date.now()

    // 预先读取 body
    let requestBody = null
    let bodyContent = null
    if (request.method !== "GET" && request.method !== "HEAD") {
      requestBody = await request.arrayBuffer()
      try {
        const bodyText = new TextDecoder().decode(requestBody)
        try {
          bodyContent = JSON.parse(bodyText)
        } catch {
          bodyContent = bodyText.substring(0, 10000)
        }
      } catch {
        bodyContent = "[binary]"
      }
    }

    // 提取所有 headers
    const headers = {}
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value
    }

    // 输出请求日志（用 wrangler tail 查看）
    console.log(JSON.stringify({
      type: "FULL_REQUEST",
      requestId,
      timestamp: new Date().toISOString(),
      url: request.url,
      method: request.method,
      headers,
      body: bodyContent && typeof bodyContent === 'object' ? {
        model: bodyContent.model,
        messages: summarizeMessages(bodyContent.messages),
        system: bodyContent.system,
        max_tokens: bodyContent.max_tokens,
        temperature: bodyContent.temperature,
        thinking: bodyContent.thinking,
        tools: bodyContent.tools,
        metadata: bodyContent.metadata,
        stream: bodyContent.stream
      } : bodyContent,
      cf: request.cf ? {
        country: request.cf.country,
        city: request.cf.city,
        colo: request.cf.colo,
      } : null
    }))

    // 检测健康检查请求，直接返回模拟响应
    if (isHealthCheckRequest(bodyContent, headers)) {
      await randomDelay()

      console.log(JSON.stringify({
        type: "HEALTH_CHECK_MOCK",
        requestId,
        duration: Date.now() - startTime
      }))

      return new Response(JSON.stringify(buildMockResponse(bodyContent?.model)), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-mock-response": "true"
        }
      })
    }

    // 转发请求
    const targetRequest = buildTargetRequest(request, requestBody)
    const response = await fetch(targetRequest)

    // 如果响应不是 200，记录错误
    if (response.status !== 200) {
      const errorBody = await response.text()
      console.log(JSON.stringify({
        type: "ERROR_RESPONSE",
        requestId,
        status: response.status,
        duration: Date.now() - startTime,
        responseBody: errorBody.substring(0, 2000), // 截取前 2000 字符
        isHtml: errorBody.trim().startsWith('<'),
        maskErrorsConfig: env.MASK_ERRORS
      }))

      // 500 错误返回未授权访问提示
      if (response.status === 500) {
        return new Response(JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "未授权访问。此 API 端点仅限 Claude Code 客户端使用，请通过官方 Claude Code CLI 访问。"
          }
        }), {
          status: 500,
          headers: {
            "content-type": "application/json"
          }
        })
      }

      // 其他错误根据 MASK_ERRORS 环境变量决定
      const shouldMaskErrors = env.MASK_ERRORS === true || env.MASK_ERRORS === "true"
      if (shouldMaskErrors) {
        return new Response(JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Rate limit exceeded. Please try again later."
          }
        }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "60"
          }
        })
      } else {
        // 透传原始错误
        return new Response(errorBody, {
          status: response.status,
          headers: response.headers
        })
      }
    }

    // 日志：请求完成（仅 200 响应）
    console.log(JSON.stringify({
      type: "RESPONSE",
      requestId,
      status: response.status,
      duration: Date.now() - startTime
    }))

    // 到这里一定是 200 响应
    if (bodyContent?.stream === true) {
      // 流式响应：使用 tee() 实现零拷贝直通 + 后台日志
      const [clientStream, logStream] = response.body.tee()

      // 后台异步处理日志流（不阻塞客户端）
      ctx.waitUntil(
        processLogStreamInBackground(logStream, requestId, bodyContent, startTime, env)
          .catch(err => console.log(JSON.stringify({
            type: 'LOG_STREAM_ERROR',
            request_id: requestId,
            error: err.message
          })))
      )

      // 立即返回客户端流（零拷贝）
      return new Response(clientStream, {
        status: response.status,
        headers: response.headers
      })
    } else if (bodyContent && typeof bodyContent === 'object') {
      // 非流式响应：直接读取 body
      const responseBody = await response.text()

      try {
        const responseData = JSON.parse(responseBody)

        // 记录成功响应到 console.log
        console.log(JSON.stringify({
          type: "SUCCESS_RESPONSE",
          requestId,
          status: response.status,
          duration: Date.now() - startTime,
          response: {
            content: responseData.content,
            stop_reason: responseData.stop_reason,
            usage: responseData.usage
          }
        }))

        ctx.waitUntil(saveToR2(env, {
          request_id: requestId,
          timestamp: new Date().toISOString(),
          latency: Date.now() - startTime,
          status: response.status,
          request: {
            model: bodyContent.model,
            messages: bodyContent.messages,
            system: bodyContent.system,
            max_tokens: bodyContent.max_tokens,
            temperature: bodyContent.temperature,
            thinking: bodyContent.thinking,
            tools: bodyContent.tools,
            metadata: bodyContent.metadata,
            stream: bodyContent.stream
          },
          response: {
            content: responseData.content,
            stop_reason: responseData.stop_reason,
            usage: responseData.usage
          }
        }))
      } catch {}

      return new Response(responseBody, {
        status: response.status,
        headers: response.headers
      })
    }

    // 不需要存储的请求，直接返回
    return response
  },

  // 定时健康检查
  async scheduled(event, env, ctx) {
    const result = await performHealthCheck(env)
    await saveHealthResult(env, result)
  }
}

// 构建转发请求
function buildTargetRequest(request, requestBody) {
  const incomingUrl = new URL(request.url)
  const targetUrl = new URL(request.url)

  targetUrl.hostname = CONFIG.TARGET_HOST
  targetUrl.protocol = "https:"

  const headers = new Headers(request.headers)
  headers.set("host", CONFIG.TARGET_HOST)
  headers.set("x-forwarded-host", incomingUrl.hostname)
  headers.set("x-forwarded-proto", "https")

  // 注入 Claude CLI 特征头
  for (const [key, value] of Object.entries(CONFIG.INJECT_HEADERS)) {
    headers.set(key, value)
  }

  // 调试：记录转发请求的关键 headers
  console.log(JSON.stringify({
    type: "FORWARDED_HEADERS",
    targetUrl: targetUrl.toString(),
    userAgent: headers.get("user-agent"),
    anthropicBeta: headers.get("anthropic-beta"),
    xApp: headers.get("x-app")
  }))

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: requestBody,
    redirect: "manual"
  })
}

// 健康检查
async function performHealthCheck(env) {
  const startTime = Date.now()

  try {
    const response = await fetch('https://anyrouter.top/v1/messages', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': `Bearer ${env.HEALTH_CHECK_KEY}`,
        ...CONFIG.INJECT_HEADERS
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251101',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '你好你是谁'
              }
            ]
          }
        ],
        system: [
          {
            type: 'text',
            text: 'You are a helpful assistant.'
          }
        ],
        tools: [],
        metadata: {
          user_id: 'health-check'
        },
        max_tokens: 1024,
        stream: true
      })
    })

    return {
      ok: response.status === 200,
      status: response.status,
      latency: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message,
      latency: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }
  }
}

async function saveHealthResult(env, result) {
  const key = `health/${result.timestamp}.json`
  await env.LOGS_BUCKET.put(key, JSON.stringify(result), {
    httpMetadata: { contentType: 'application/json' }
  })
  console.log(JSON.stringify({ type: 'HEALTH_CHECK', ...result }))
}

// 健康检查页面
function renderHealthPage() {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>anyrouter 健康状态</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { color: #333; }
    .summary { display: flex; gap: 20px; margin-bottom: 20px; }
    .card { background: white; padding: 20px; border-radius: 8px; flex: 1; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .ok { color: #22c55e; }
    .fail { color: #ef4444; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
    th { background: #f8f9fa; text-align: left; padding: 12px; }
    td { padding: 12px; border-top: 1px solid #eee; }
    .status-badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status-ok { background: #dcfce7; color: #166534; }
    .status-fail { background: #fee2e2; color: #991b1b; }
  </style>
</head>
<body>
  <h1>anyrouter.top 健康状态</h1>
  <div class="summary">
    <div class="card">
      <div>当前状态</div>
      <div id="current" style="font-size: 24px;">-</div>
    </div>
    <div class="card">
      <div>可用率</div>
      <div id="uptime" style="font-size: 24px;">-</div>
    </div>
    <div class="card">
      <div>平均延迟</div>
      <div id="latency" style="font-size: 24px;">-</div>
    </div>
  </div>
  <table>
    <thead><tr><th>时间</th><th>状态</th><th>HTTP</th><th>延迟</th></tr></thead>
    <tbody id="history"></tbody>
  </table>
  <script>
    fetch('/health/api')
      .then(r => r.json())
      .then(data => {
        if (data.length === 0) {
          document.getElementById('history').innerHTML = '<tr><td colspan="4">暂无数据</td></tr>'
          return
        }
        const okCount = data.filter(r => r.ok).length
        const uptime = ((okCount / data.length) * 100).toFixed(1)
        const avgLatency = Math.round(data.reduce((a, r) => a + r.latency, 0) / data.length)
        const latest = data[0]

        document.getElementById('current').innerHTML = latest.ok
          ? '<span class="ok">正常</span>'
          : '<span class="fail">故障</span>'
        document.getElementById('uptime').textContent = uptime + '%'
        document.getElementById('latency').textContent = avgLatency + 'ms'

        document.getElementById('history').innerHTML = data.map(r => \`
          <tr>
            <td>\${new Date(r.timestamp).toLocaleString('zh-CN')}</td>
            <td><span class="status-badge \${r.ok ? 'status-ok' : 'status-fail'}">\${r.ok ? '正常' : '故障'}</span></td>
            <td>\${r.status}</td>
            <td>\${r.latency}ms</td>
          </tr>
        \`).join('')
      })
  </script>
</body>
</html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

async function getHealthHistory(env) {
  const list = await env.LOGS_BUCKET.list({ prefix: 'health/', limit: 100 })

  const results = await Promise.all(
    list.objects
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, 50)
      .map(async obj => {
        const data = await env.LOGS_BUCKET.get(obj.key)
        return data ? JSON.parse(await data.text()) : null
      })
  )

  return new Response(JSON.stringify(results.filter(Boolean)), {
    headers: { 'Content-Type': 'application/json' }
  })
}
