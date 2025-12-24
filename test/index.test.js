import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('LLM Proxy Worker', () => {
  describe('Health Check Detection', () => {
    it('should return mock response for health check request', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('x-mock-response')).toBe('true')

      const data = await response.json()
      expect(data.content[0].text).toBe('Hi! How can I help you today?')
      expect(data.stop_reason).toBe('end_turn')
      expect(data.usage).toBeDefined()
    })

    it('should NOT mock when content is not "hi"', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hello world' }],
          max_tokens: 10,
          tools: [],
        }),
      })

      // Should not be a mock response (will try to forward)
      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when user-agent is not Go-http-client', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'claude-cli/2.0.76 (external, cli)',
          'authorization': 'Bearer test-token',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
          stream: true,
          metadata: { user_id: 'test' },
          system: [{ type: 'text', text: 'You are helpful.' }],
        }),
      })

      // Should not be a mock response
      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when has stream field', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
          stream: true,
        }),
      })

      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when has metadata field', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
          metadata: { user_id: 'test' },
        }),
      })

      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when has system field', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
          system: 'You are helpful.',
        }),
      })

      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when messages has more than 1 item', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
          max_tokens: 10,
          tools: [],
        }),
      })

      expect(response.headers.get('x-mock-response')).toBeNull()
    })

    it('should NOT mock when authorization header present', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
          'authorization': 'Bearer token',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
        }),
      })

      expect(response.headers.get('x-mock-response')).toBeNull()
    })
  })

  describe('Mock Response Format', () => {
    it('should return correct mock response structure', async () => {
      const response = await SELF.fetch('https://api.cthlwy.social/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Go-http-client/2.0',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5-20251101',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          tools: [],
        }),
      })

      const data = await response.json()

      expect(data.id).toMatch(/^msg_/)
      expect(data.type).toBe('message')
      expect(data.role).toBe('assistant')
      expect(data.model).toBe('claude-opus-4-5-20251101')
      expect(data.stop_reason).toBe('end_turn')
      expect(data.stop_sequence).toBeNull()
      expect(data.usage.input_tokens).toBe(8)
      expect(data.usage.output_tokens).toBe(12)
    })
  })
})
