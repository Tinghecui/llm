# LLM Proxy - Cloudflare Worker 项目

## 项目概述

这是一个 Cloudflare Worker 项目，用于将 `api.cthlwy.social` 的请求转发到 `anyrouter.top`，并自动注入 Claude CLI 特征头伪装成官方客户端。

---

## 功能清单

### 1. API 转发
- 将所有请求从 `api.cthlwy.social` 转发到 `anyrouter.top`
- 保留原始请求的 method、body
- 添加 `x-forwarded-host` 和 `x-forwarded-proto` 头

### 2. Claude CLI 特征头注入
自动为所有请求注入以下 Claude CLI 特征头，伪装成官方客户端：

```
user-agent: claude-cli/2.0.76 (external, cli)
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27
anthropic-dangerous-direct-browser-access: true
x-app: cli
x-stainless-arch: arm64
x-stainless-os: MacOS
x-stainless-lang: js
x-stainless-runtime: node
x-stainless-runtime-version: v24.3.0
x-stainless-package-version: 0.70.0
x-stainless-helper-method: stream
x-stainless-timeout: 600
x-stainless-retry-count: 0
```

### 3. 健康检查请求 Mock
自动识别健康检查请求（9个特征全部匹配），返回模拟响应：

**识别特征（全部满足）：**

| 类型 | 特征 |
|------|------|
| Headers | `user-agent` 包含 `Go-http-client` |
| Headers | 有 `x-api-key` |
| Headers | 没有 `authorization` |
| Body | `messages` 长度 = 1 |
| Body | `content` = `"hi"` (字符串格式) |
| Body | `tools` = `[]` 空数组 |
| Body | 没有 `stream` 字段 |
| Body | 没有 `metadata` 字段 |
| Body | 没有 `system` 字段 |

**Mock 响应：**
- 延迟 2-4 秒（随机）
- 返回 `"Hi! How can I help you today?"`
- 响应头包含 `x-mock-response: true`

### 4. R2 日志存储（训练数据收集）
将请求和响应数据持久化存储到 Cloudflare R2：

**存储条件：**
- 只记录成功响应（status === 200）
- 排除健康检查请求

**存储的数据字段：**

| 类型 | 字段 |
|------|------|
| 元数据 | `request_id`, `timestamp`, `latency`, `status` |
| 请求 | `model`, `messages`, `system`, `max_tokens`, `temperature`, `thinking`, `tools`, `metadata`, `stream` |
| 响应 | `content`, `stop_reason`, `usage.input_tokens`, `usage.output_tokens` |

**存储路径：**
```
llm-logs/logs/{date}/{request_id}.json
```

**流式响应处理：**
- 使用 `ReadableStream.tee()` 零拷贝分流技术
- 客户端流：直接透传，零延迟（相比 TransformStream 消除 5-20ms 延迟）
- 日志流：后台异步解析 SSE 事件，不阻塞响应
- 累积 `content_block_delta` 事件拼接完整输出
- 从 `message_delta` 提取 `stop_reason` 和 `usage`
- 使用 `ctx.waitUntil()` 异步写入 R2

### 5. 请求日志
- **实时日志 (console.log)**：记录请求摘要（避免 256KB 限制）
  - 记录 headers、URL、method
  - body 只记录摘要（model、message_count、stream、max_tokens）
  - 完整 body 保存在 R2，console.log 只用于实时调试
- 使用 `npm run tail` 或 `wrangler tail --format=json` 查看
- 日志类型：
  - `FULL_REQUEST` - 请求详情
  - `RESPONSE` - 响应状态
  - `HEALTH_CHECK_MOCK` - 健康检查被 mock
  - `HEALTH_CHECK` - 定时健康检查结果
  - `R2_SAVED` - R2 存储成功
  - `R2_SAVE_ERROR` - R2 存储失败

### 6. 定时健康检查 + 状态页面
每 5 分钟自动检测 anyrouter.top 是否可用，结果存储到 R2，提供网页查看。

**检查请求：**
```json
{
  "model": "claude-opus-4-5-20251101",
  "messages": [{ "role": "user", "content": "你好你是谁" }],
  "max_tokens": 100
}
```

**判断标准：**
- `status === 200` → 正常
- `status !== 200` → 故障
- 网络错误 → 故障

**访问方式：**
- 状态页面：`https://api.cthlwy.social/health`
- API 数据：`https://api.cthlwy.social/health/api`

**页面展示：**
- 当前状态（正常/故障）
- 可用率统计
- 平均延迟
- 最近 50 条检查记录

**需要配置 Secret：**
```bash
wrangler secret put HEALTH_CHECK_KEY  # 健康检查用的 API Key
```

---

## 项目文件结构

```
llm-proxy/
├── .github/
│   └── workflows/
│       └── ci.yml            # GitHub Actions CI/CD
├── src/
│   └── index.js              # Worker 主代码
├── test/
│   └── index.test.js         # 单元测试
├── scripts/
│   └── replay-request.js     # 请求重放工具
├── wrangler.toml             # Cloudflare 配置
├── vitest.config.js          # 测试配置
├── package.json              # npm 脚本
└── CLAUDE.md                 # 本文件
```

---

## 命令行操作

```bash
# 安装依赖
npm install

# 本地开发测试
npm run dev

# 运行测试
npm test
npm run test:watch    # 监听模式

# 部署到 Cloudflare
npm run deploy

# 查看实时日志
npm run tail
npm run tail -- --format=json              # JSON 格式
npm run tail -- --format=json | grep FULL  # 只看请求

# R2 日志管理
npx wrangler r2 object list llm-logs                              # 列出文件
npx wrangler r2 object get llm-logs logs/2025-12-25/{id}.json    # 下载文件
```

---

## CI/CD

GitHub Actions 自动化流程（`.github/workflows/ci.yml`）：

1. **测试**：每次 push/PR 自动运行 vitest 测试
2. **部署**：main 分支测试通过后自动部署到 Cloudflare Workers

**需要配置的 Secrets：**
- `CLOUDFLARE_API_TOKEN` - Cloudflare API Token（需要 Workers 和 R2 权限）

---

## 日志格式

### FULL_REQUEST（请求详情）
```json
{
  "type": "FULL_REQUEST",
  "requestId": "uuid",
  "timestamp": "2025-12-27T05:55:35.455Z",
  "url": "https://api.cthlwy.social/v1/messages",
  "method": "POST",
  "headers": { ... },
  "bodyInfo": {
    "model": "claude-haiku-4-5-20251001",
    "message_count": 2,
    "stream": true,
    "max_tokens": 64000
  },
  "cf": { "country": "US", "city": "Santa Clara", "colo": "SJC" }
}
```
**注意**：`bodyInfo` 只包含摘要信息，完整的 `messages` 和 `system` 保存在 R2。

### RESPONSE（响应状态）
```json
{
  "type": "RESPONSE",
  "requestId": "uuid",
  "status": 200,
  "duration": 1476
}
```

### R2 存储数据格式
```json
{
  "request_id": "uuid",
  "timestamp": "2025-12-25T20:00:00.000Z",
  "latency": 1234,
  "status": 200,
  "request": {
    "model": "claude-opus-4-5-20251101",
    "messages": [...],
    "system": [...],
    "max_tokens": 32000,
    "temperature": null,
    "thinking": null,
    "tools": [],
    "metadata": { "user_id": "..." },
    "stream": true
  },
  "response": {
    "content": [{ "type": "text", "text": "..." }],
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 100,
      "output_tokens": 50
    }
  }
}
```

---

## 客户端特征对比

| 特征 | Claude CLI | Go 客户端（健康检查） |
|------|-----------|----------------------|
| `user-agent` | `claude-cli/2.0.76` | `Go-http-client/2.0` |
| `authorization` | Bearer token | 无 |
| `x-api-key` | 无 | 有 |
| `anthropic-beta` | 有 | 无 |
| `x-stainless-*` | 全部有 | 无 |
| `stream` | `true` | 无 |
| `metadata` | 有 | 无 |
| `system` | 有 | 无 |

---

## 注意事项

1. **付费版 Worker**：建议升级到付费版（$5/月）获得 50ms CPU 时间，支持大响应的完整存储
2. **R2 免费额度**：10GB 存储，100万次请求/月
3. **流式响应**：使用 Stream Tee 零拷贝技术，客户端延迟为 0ms，日志流后台异步处理
4. **健康检查 Mock**：返回延迟 2-4 秒，避免被检测为异常
5. **console.log 限制**：256KB/请求，已优化为只记录摘要（完整数据在 R2）

---

## 更新历史

### 2025-12-27 (v4)
1. **Stream Tee 零拷贝优化**
   - 从 `TransformStream` 改为 `ReadableStream.tee()`
   - 客户端流零拷贝直通，消除 5-20ms 延迟
   - 日志流后台异步处理，完全用户无感
   - 性能提升：客户端延迟降至 0ms
2. **console.log 日志优化**
   - 移除 `body` 完整记录，改为 `bodyInfo` 摘要
   - 避免 Cloudflare 256KB/请求限制
   - 完整数据仍保存在 R2，不影响训练数据收集

### 2025-12-25 (v3)
1. **添加定时健康检查**
   - 每 5 分钟检测 anyrouter.top 可用性
   - 使用 Cloudflare Cron Triggers
   - 结果存储到 R2（`health/` 目录）
2. **添加健康状态页面**
   - `/health` 查看状态和历史
   - `/health/api` 获取 JSON 数据
   - 显示可用率和平均延迟

### 2025-12-25 (v2)
1. **添加健康检查请求识别和 Mock 响应**
   - 9 个特征全部匹配才识别为健康检查
   - 返回模拟响应，延迟 2-4 秒
2. **添加 R2 日志存储**
   - 存储请求和响应数据用于训练
   - 支持流式响应的完整捕获
   - 只记录成功响应
3. **添加 CI/CD**
   - vitest 单元测试
   - GitHub Actions 自动测试和部署
4. **添加 nodejs_compat 兼容性标志**

### 2025-12-25 (v1)
1. 移除 KV 错误日志（配额限制）
2. 移除重试机制
3. 添加完整请求日志到 console.log
4. **添加 Claude CLI 特征头自动注入**
5. 添加请求重放脚本 `scripts/replay-request.js`
6. 分析并记录 Claude CLI vs Go 客户端的请求特征差异

### 2024-12-22
1. 创建基础转发功能
2. 添加 console.log 日志
3. 添加 KV 持久化错误日志
4. 实现重试机制（指数退避）
5. 修复 ReadableStream 重复读取问题（POST body）
6. 添加上游错误 body 记录
7. 统一错误返回为 413
8. 延长重试间隔至最长 6 分钟
9. 迁移到本地 wrangler 项目管理
