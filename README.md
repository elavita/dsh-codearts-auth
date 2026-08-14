# dsh-codearts-auth

deepseek-harness 插件：执行 CodeArts（华为云）浏览器登录流程（ticket 流程），
在临时凭证过期前重新运行登录以续期，并注册一个 `codearts` LLM provider 路由，
使该凭证可直接用于 CodeArts 后端模型调用。

## 安装

```sh
dsh plugin add dsh-codearts-auth
```

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

- `/codearts-login` — 在浏览器中打开华为云登录页；授权后，插件会存储临时
  AK/SK/SecurityToken 凭证。
- `/codearts-status` — 显示 `configured`、`source`、`expiresAt`、
  `refreshable` 以及最新的 `refreshError`。
- `/codearts-refresh` — 手动续期凭证（重新运行登录流程）。
- 编程式调用：`ctx.codeartsAuth.login()`、`ctx.codeartsAuth.status()`、
  `ctx.codeartsAuth.refresh()`、`ctx.codeartsAuth.logout()`。

## LLM provider

插件在 `ctx.llm` 上注册了一个 `codearts` provider 路由（OpenAI 兼容端点
`https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`）。每个模型请求都使用
存储的 AK/SK/SecurityToken 按华为 `SDK-HMAC-SHA256` 方案签名，并附带
`Chat-Id`/`Session-Id` 请求头。默认广告的模型为 GLM-5.2、GLM-5.1 和
GLM-5。登录后在 dsh Models 页面选择该 provider 即可。

## 凭证

- Ref：`CODEARTS_ACCESS_TOKEN`（POSIX 标识符格式的凭证 ref）。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。
- `status()` 报告 `configured`、`source`、`expiresAt`、`refreshable` 和
  `refreshError`。

## 续期（refresh）

- 旧版 CodeArts ticket 流程签发短期凭证（约 1 天）且没有 refresh token，因此续期
  意味着重新运行浏览器登录流程。
- 凭证会在 `expires_at` 前 1 小时续期（与 CodeArts IDE 的提前量一致），或当已处于
  到期窗口内时立即续期；浏览器会打开等待再点一次授权。
- 手动续期：`/codearts-refresh` 或 `ctx.codeartsAuth.refresh()`。
- 失败后 10 分钟重试，并体现在 `status().refreshError` 中。
- 续期定时器是 unref 的，在 `logout()` 和插件卸载时停止。

## 开发

- `pnpm test` — 单元测试（快速，无网络）。
- `pnpm test:e2e` — 针对华为线上端点的真实登录流程；需要在打开的浏览器中由人工
  点击授权按钮（续期场景需点两次）。
- `pnpm typecheck`、`pnpm build`。

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`（生成 `.js`、`.d.ts` 和 source
  map）。插件入口是 `lib/index.js`，而 `lib/` 已被 gitignore，因此构建是安装或
  运行前的必需步骤。
- `pnpm typecheck` — 只做类型检查（`tsc --noEmit`），不产出文件，可在构建前快速
  验证。

每次修改 `src/` 后都需要重新执行 `pnpm build`——dsh 启动时不会自动重建。

### 安装到 profile 之前先构建

`dsh plugin` 会把本地检出安装为 pnpm `link:` 依赖——即指向本目录的符号链接——
而 pnpm 从不为 `link:` 依赖运行构建脚本（`prepare` 脚本只在打包发布或
registry/git 安装时执行）。包的入口是编译产物 `lib/index.js`（已被 gitignore，
由 `pnpm build` 生成），因此未构建的检出会在 dsh 启动时报
`ERR_MODULE_NOT_FOUND: ... dsh-codearts-auth/lib/index.js`。

构建后再安装（先构建或后构建均可），然后重新运行 `dsh`——链接会立即看到
`lib/`：

```sh
pnpm build                        # 在本仓库中
dsh plugin --profile <name> install <path-to-this-repo>
dsh <name>                        # 或：pnpm dsh <name>
```

每次修改 `src/` 后都需要重新构建——`dsh` 启动时不会自动重建。

## 工作原理

1. 生成 `ticket_id` 和密钥，并启动本地 `127.0.0.1` 回调服务器。
2. 构造重定向 URL（`devcloud.cn-north-4.huaweicloud.com/doer/redirect`）并打开
   华为认证页面。
3. 收到回调后，轮询 snap-manager ticket 端点（120 × 1 秒）获取临时凭证。
4. 将凭证 JSON 存储到 `CODEARTS_ACCESS_TOKEN` 下。
5. 在到期前重新运行登录流程以续期。
