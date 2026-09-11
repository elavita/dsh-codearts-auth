# e2e 测试说明（重要：部分用例会消耗真实积分）

本目录下的用例会访问**真实线上后端**。请务必按下表理解每个文件的行为，
不要用「一把梭跑整个目录」的方式运行。

## ⚠️ 会消耗模型积分（发真实 chat/completions 请求）

| 文件 | 闸门 | 说明 |
|------|------|------|
| `buddy-models.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 用适配器拉取 CodeBuddy 模型并逐个发一次对话 |
| `buddy-cache-probe.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 直连 `/v2/chat/completions`，发 3 组前缀做缓存对比 |
| `buddy-pool-probe.e2e.spec.ts` | `DSH_BUDDY_POOL_E2E=1` + `DSH_BUDDY_POOL_E2E_CONFIRM=yes` | 用账号池凭据走完整 LLM 链路 |

## 不消耗模型积分

| 文件 | 闸门 | 说明 |
|------|------|------|
| `v4-models.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash / pro（**每日 1000 万免费 Tokens**） |
| `v4-large-write.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash 大文件写入（同上，免费额度） |
| `login.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | 只走 CodeArts 浏览器登录与凭据换取 |
| `buddy-login-probe.e2e.spec.ts` | `DSH_BUDDY_PROBE=1` | 只打印登录流程原始响应，不发模型请求 |

> CodeArts deepseek-v4 系列使用华为云免费福利额度（每日 1000 万免费 Tokens），
> 不产生额外费用，因此 `DSH_CODEARTS_E2E=1` 不需要确认变量。
> glm-5.3-flash 等其他 benefit 模型不在本测试集内。如有添加务必标注消耗情况。

## 运行方式

**永远显式指定文件**，不要运行整个目录：

```bash
# 只做认证（安全）
pnpm test:e2e:login

# 登录流程原始响应探针（安全，不发模型请求）
pnpm test:e2e:buddy-probe

# ⚠️ 会消耗 CodeBuddy 积分
pnpm test:e2e:buddy

# ⚠️ 会消耗 CodeArts 积分
pnpm test:e2e:codearts
```

## 单元测试

`pnpm test`（默认）只跑 `tests/unit/**`，**全部使用桩函数，不发起任何网络请求**，
可以放心频繁运行。

## 为什么默认全部 skip

e2e 用例在未设置闸门时通过 `describe.skip` 整体跳过，报告里显示为
`skipped`，不会产生任何网络调用。这样做是为了防止：

- CI 或其他开发者误跑而消耗配额；
- CodeBuddy 的 14 天免费试用期结束后（2026-09-10 止）在付费账号上产生真实费用。
