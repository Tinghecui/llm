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

### 3. 请求日志
- **实时日志 (console.log)**：记录完整请求信息（headers、body）
- 使用 `npm run tail` 或 `wrangler tail --format=json` 查看
- 日志类型：`FULL_REQUEST`（请求详情）、`RESPONSE`（响应状态）

---

## 代码配置

```javascript
const CONFIG = {
  TARGET_HOST: "anyrouter.top",
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
```

---

## 日志格式

### FULL_REQUEST（请求详情）
```json
{
  "type": "FULL_REQUEST",
  "requestId": "uuid",
  "timestamp": "2025-12-25T18:02:25.296Z",
  "url": "https://api.cthlwy.social/v1/messages",
  "method": "POST",
  "headers": { ... },
  "body": { ... },
  "cf": { "country": "US", "city": "Santa Clara", "colo": "SJC" }
}
```

### RESPONSE（响应状态）
```json
{
  "type": "RESPONSE",
  "requestId": "uuid",
  "status": 200,
  "duration": 1476
}
```

---

## 客户端特征对比

| 特征 | Claude CLI | Go 客户端 |
|------|-----------|-----------|
| `user-agent` | `claude-cli/2.0.76 (external, cli)` | `Go-http-client/1.1` |
| `anthropic-beta` | 含 `claude-code-20250219` | 不含 |
| `x-stainless-*` | 全部有 | 无 |
| `x-app` | `cli` | 无 |
| `stream` | `true` | 无/null |
| `thinking` | 有 | 无 |
| `temperature` | 无 | `1` |

---

## 项目文件结构

```
llm-proxy/
├── src/
│   └── index.js              # Worker 主代码
├── scripts/
│   └── replay-request.js     # 请求重放工具
├── wrangler.toml             # Cloudflare 配置
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

# 部署到 Cloudflare
npm run deploy

# 查看实时日志（抓取请求）
npm run tail
npm run tail -- --format=json              # JSON 格式
npm run tail -- --format=json | grep FULL  # 只看请求

# 请求重放工具（需要 KV 有数据）
npm run requests                           # 列出保存的请求
npm run request:curl -- "<key>"            # 生成 curl 命令
npm run request:fetch -- "<key>"           # 生成 fetch 代码
npm run request:replay -- "<key>"          # 直接重放请求
```

---

## 抓取请求示例

```bash
# 抓取并保存到文件
npx wrangler tail --format=json > requests.log

# 提取 FULL_REQUEST
cat requests.log | jq -r '.logs[]?.message[]?' | grep FULL_REQUEST

# 解析请求详情
cat requests.log | jq -r '.logs[]?.message[]?' | grep FULL_REQUEST | jq '.headers'
```

---

## 注意事项

1. **KV 配额限制**：Cloudflare 免费版每天只有 1000 次 KV 写入，已移除 KV 持久化，改用 console.log
2. **重试机制已关闭**：`MAX_RETRIES = 0`，直接转发不重试
3. **特征头注入**：所有请求都会被注入 Claude CLI 特征头

---

## 更新历史

### 2025-12-25
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
