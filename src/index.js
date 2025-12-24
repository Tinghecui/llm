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

// 主入口
export default {
  async fetch(request, env, ctx) {
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

    // 输出完整请求到日志（用 wrangler tail 查看）
    console.log(JSON.stringify({
      type: "FULL_REQUEST",
      requestId,
      timestamp: new Date().toISOString(),
      url: request.url,
      method: request.method,
      headers,
      body: bodyContent,
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

    // 日志：请求完成
    console.log(JSON.stringify({
      type: "RESPONSE",
      requestId,
      status: response.status,
      duration: Date.now() - startTime
    }))

    return response
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

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: requestBody,
    redirect: "manual"
  })
}
