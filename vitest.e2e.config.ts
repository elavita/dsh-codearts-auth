import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    // 每个真实登录用例 240 秒：为人工完成门户
    // 授权留有充裕时间，同时适配整个运行 300 秒的 bash 超时。
    testTimeout: 240_000,
  },
})
