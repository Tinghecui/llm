# LLM Proxy

Cloudflare Worker 用于转发 API 请求到 anyrouter.top，带日志和重试机制。

## 功能

- API 请求转发
- 自动重试（最多 10 次，最长 6 分钟）
- 日志记录（console.log + KV 存储）
- 错误统一返回 413

## 命令

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 部署到 Cloudflare
npm run deploy

# 查看实时日志
npm run tail
```

## 配置

编辑 `wrangler.toml`，替换 KV namespace ID。
