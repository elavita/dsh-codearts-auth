import { describe, expect, it } from 'vitest'
import { openBrowser, runLoginFlow } from '../../src/login.js'
import type { CodeArtsCredential } from '../../src/types.js'

// 仅在 `pnpm test:e2e` 下执行（需设置 DSH_CODEARTS_E2E=1）；
// 默认跳过，以免 CI 和普通 `pnpm test` 打开浏览器。
const E2E = process.env.DSH_CODEARTS_E2E === '1'

describe.runIf(E2E)('codearts login e2e', () => {
  it('completes a real browser login and returns a usable credential', async () => {
    const result = await runLoginFlow({
      openBrowser: (url) => {
        console.log('请打开此 URL 并完成 CodeArts 登录：\n' + url)
        openBrowser(url)
      },
    })
    expect(result.access.length).toBeGreaterThan(0)
    expect(result.expires).toBeGreaterThan(Date.now())
    const credential = JSON.parse(result.access) as CodeArtsCredential
    // 凭据必须可用于调用 codearts 后端 API：AK/SK
    // 对用于签名每个请求（SDK-HMAC-SHA256 + X-Security-Token）。
    expect(credential.access_key_id).toBeTruthy()
    expect(credential.secret_access_key).toBeTruthy()
    expect(credential.security_token).toBeTruthy()
    expect(credential.expires_at).toBeTruthy()
  })

  it('renews the credential by re-running the login flow', async () => {
    // 旧版 ticket 流程签发的短时凭据不含刷新
    // 令牌；续期意味着重新进行浏览器登录（调度器在过期
    // 前不久触发此操作）。验证第二次登录能获得有效凭据。
    const result = await runLoginFlow({
      openBrowser: (url) => {
        console.log('请打开此 URL 并完成 CodeArts 登录：\n' + url)
        openBrowser(url)
      },
    })
    const credential = JSON.parse(result.access) as CodeArtsCredential
    expect(credential.access_key_id).toBeTruthy()
    expect(credential.security_token).toBeTruthy()
    expect(result.expires).toBeGreaterThan(Date.now())
  }, 240_000)
})
