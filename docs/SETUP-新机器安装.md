# 从零安装 DSH + buddy/workbuddy 反代插件

> **给在新电脑上执行的 AI agent**：本文是一份**可独立执行的安装手册**。
> 逐步照做即可，不要跳步。每条命令都给出**预期输出**，输出不符就先排查再往下走。
> 全文不包含任何他人账号、token 或凭据——登录由使用者在**浏览器里手工完成**。

---

## 0. 目标与产物

装完之后这台机器能：

1. 用 `dsh web` 启动 DSH Web GUI（`http://127.0.0.1:3080`）
2. 在 GUI 里通过浏览器登录 **WorkBuddy（国际版）/ CodeBuddy（中国版）/ CodeArts** 账号
3. 把这一批账号当成本机的 LLM provider 使用，**额度用完自动换号**
4. 在侧栏看到**剩余额度**与**账号可用性状态灯**

**两个插件**：

| 插件 | 仓库 | 作用 |
|---|---|---|
| `dsh-codearts-auth` | https://github.com/elavita/dsh-codearts-auth | 反代本体：三个 provider、浏览器登录、账号池、限流换号、每日签到 |
| `dsh-credits-widget` | https://github.com/elavita/dsh-credits-widget | 侧栏额度挂件 + 签到 + 用量统计 |

> `dsh-credits-widget` **依赖** `dsh-codearts-auth` 提供的账号池与 RPC，
> **必须先装前者**，否则挂件读不到数据。

---

## 1. 前置检查

### 1.1 必须已具备

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | `^22.19.0 \|\| >=24` | `node -v` |
| pnpm | 任意近期版本 | `pnpm -v` |
| **Chrome 或 Edge** | **必须本地已安装** | 见下 |
| 网络 | 能访问 GitHub | — |

**Chrome/Edge 是硬性依赖**：登录流程会以**隔离 profile** 启动本机 Chrome 或 Edge
（全新技术 profile，不含已有 Cookie）。插件的查找顺序是：

```
%ProgramFiles%\Google\Chrome\Application\chrome.exe
%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
```

自查（任一存在即可）：

```powershell
@(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ }
```

无输出 = 没装浏览器，**先装 Chrome 或 Edge**，否则登录会失败。

### 1.2 若还没有 DSH

```powershell
npm install -g @deepseek-ai/dsh
dsh --version
```

预期：打印形如 `0.1.5-rc.1` 的版本号。

> 参考环境（本项目验证过的组合）：Node `v24.13.0`、pnpm `11.7.0`、
> `@deepseek-ai/dsh@0.1.5-rc.1`。版本接近即可，无需完全一致。

---

## 2. 安装插件

DSH 的插件装在一个 **profile** 目录下（本手册统一用 **`web`**）：
`~/.dsh/profiles/web/`（Windows：`C:\Users\<用户>\.dsh\profiles\web\`）。

`dsh plugin --profile web <cmd>` 等价于**在该目录里跑 pnpm**。

### 2.1 先放行 build 脚本（**最容易卡住的一步**）

两个插件都靠 `prepare` 脚本在安装时自动构建 `lib/`。pnpm 默认**拦截**未放行的
构建脚本，**直接报错中止安装**（不是静默失败）：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package ...
The git-hosted package "dsh-credits-widget@0.1.0" needs to execute build scripts
but is not in the "allowBuilds" allowlist.
```

**关键**：`allowBuilds` 的键**必须带解析出的 commit SHA**（`#<sha>`），
只写仓库 URL 不够。好在 **pnpm 会把可直接粘贴的整行打印出来**：

```
Add the package to "allowBuilds" in your project's pnpm-workspace.yaml. For example:
allowBuilds:
  dsh-credits-widget@git+https://.../dsh-credits-widget.git#f839a90a...: true
```

**推荐流程**（不用事先猜 SHA）：

1. **先直接执行 2.2 / 2.3 的 `add` 命令**
2. 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 时，**把报错里给出的那行原样**追加到
   `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds:` 下
3. **重跑同一条 `add` 命令**，即可通过

`pnpm-workspace.yaml` 追加后形如：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  "dsh-credits-widget@git+https://github.com/elavita/dsh-credits-widget.git#<sha>": true
  "dsh-codearts-auth@git+https://github.com/elavita/dsh-codearts-auth.git#<sha>": true
```

> - `<sha>` 用**报错信息里 pnpm 实际给出的值**，不要照抄本手册。
> - 键含 `:` 和 `#`，**建议加引号**。
> - 若该文件不存在，说明 profile 还没初始化——先跑一次 `dsh web` 让它生成。

### 2.2 安装反代本体

```powershell
dsh plugin --profile web add "https://github.com/elavita/dsh-codearts-auth.git"
```

预期结尾出现 `dependencies: + dsh-codearts-auth`，以及自动执行的
`prepare` → `pnpm build:all` 日志，最后打印 `Wrote ...lib/client/jet-hub.js`。

> **若报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`** —— 正常，按 **2.1** 的做法把报错里
> 给出的 `allowBuilds` 行加进 `pnpm-workspace.yaml`，再重跑本命令。
>
> **若卡住 / `Connection was reset` / 拉取超时** —— 直连 GitHub 不通，改用镜像前缀：
> ```powershell
> dsh plugin --profile web add "https://gh-proxy.com/https://github.com/elavita/dsh-codearts-auth.git"
> ```
> 这只是加了个前缀，后续仍走标准 git 流程，功能完全一致。

> 该包**未发布到 npm**，只能从 git 安装。pnpm 以 `git+https` 方式拉取并自动运行
> `prepare` 构建 `lib/`，**无需**手工 `pnpm build`。

### 2.3 安装额度挂件

```powershell
dsh plugin --profile web add "https://github.com/elavita/dsh-credits-widget.git"
```

同样，直连不通就换 `https://gh-proxy.com/https://github.com/elavita/dsh-credits-widget.git`。

### 2.4 确认两者都进了 profile 的 bundle 列表

查看 `~/.dsh/profiles/web/package.json`，`dsh.profile.bundles` 应包含：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-codearts-auth",
      "dsh-credits-widget"
    ],
    "patchReload": "live"
  }
}
```

**若缺失**：两个包各自声明了 `dsh.bundle.patch`（`cordis.patch.yml`），
正常会在安装时自动并入 layer 栈。没自动加就手工把这两行补进 `bundles` 数组。

### 2.5 校验产物存在

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-codearts-auth\lib\index.js"
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-codearts-auth\lib\client\jet-hub.js"
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-credits-widget\lib\index.js"
```

三个都应为 `True`。`lib/client/jet-hub.js` 是**客户端 bundle**，缺了 GUI 里的
「Jet Hub」设置页不会出现。

---

## 3. 启动

```powershell
dsh web
```

预期：打印监听地址，浏览器打开 **http://127.0.0.1:3080**。

启动日志中**不应**出现 `ERR_MODULE_NOT_FOUND`。若出现，回到 2.1 检查
`allowBuilds` 是否放行，并确认 `lib/` 已生成。

---

## 4. 登录账号（在浏览器里手工完成）

这一步是**使用者本人**在浏览器里的操作，agent 无法代为完成（涉及真人账号密码
与短信/扫码验证）。全程**不需要**向任何人索要 token。

### 4.1 入口

GUI 左下角 **设置（⚙）→ Jet Hub**。

### 4.2 登录步骤

1. 点 **「+ 新建账号」**
2. **选择 provider**：`WorkBuddy（国际版）` 或 `CodeBuddy（中国版）`
3. 插件会**自动以隔离浏览器**打开官方登录页（全新 profile，不带上本机已有登录态）
4. 在打开的窗口里**正常登录**（账号密码 / 扫码 / 验证码）
5. 登录成功后窗口可关闭，插件自动收取凭据并加入账号池，列表出现新账号

> **为什么用隔离浏览器**：若复用日常浏览器，OAuth（如 GitHub 登录）会直接沿用
> 已登录的第一个账号，**无法切换账号**。隔离 profile 保证每次都是干净的登录态。
> 若隔离浏览器启动失败，插件会**回退**到系统默认浏览器并在界面提示
> 「可能复用已有登录态」——此时多账号切换可能不灵。

### 4.3 验证登录成功

Jet Hub 面板应显示该账号，且：

```powershell
dsh web   # 若已在运行可跳过，然后在 GUI 里查看
```

- 账号行有**绿色状态灯**（= 当前模型下可用）
- 侧栏底部出现 **`● 剩余额度`** 入口行，点击弹出浮层能看到数字

### 4.4 设为默认模型

GUI → **设置 → 模型**，把 provider 选成 `workbuddy`（或 `buddy`）与目标模型
（如 `deepseek-v4.1-flash`）。之后新会话即走该 provider。

---

## 5. 日常使用

| 功能 | 位置 |
|---|---|
| 剩余额度 / 用量统计 | 侧栏底部 `● 剩余额度`，点行展开统计面板 |
| 账号可用性状态灯 | 入口行的小圆点：🟢可用 🔴限流 ⚪停用 🟡未知 |
| 新增 / 停用 / 删除账号 | 设置 → Jet Hub |
| 一键领取积分（签到） | Jet Hub 的 **CodeBuddy** 面板（点「一键领取」） |
| 额度用完自动换号 | Jet Hub 开关，默认按池中下一个可用账号重试 |

**签到只对 CodeBuddy 有效**——WorkBuddy 国际版后端**没有**签到接口，
因此国际版面板不提供「一键领取积分」。

---

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 正常第一步。把报错里 pnpm **给出的那行** `allowBuilds` 加进 `pnpm-workspace.yaml`，重跑 `add`（见 2.1） |
| `add` 卡住 / `Connection was reset` | 直连 GitHub 不通。改用 `https://gh-proxy.com/` 前缀重试（见 2.2） |
| 启动报 `ERR_MODULE_NOT_FOUND: .../lib/index.js` | `prepare` 没跑成功。检查 2.1 的 `allowBuilds` 是否已放行；或手工 `pnpm build:all` 后重装 |
| GUI 里没有 Jet Hub 设置页 | 缺客户端 bundle。确认 `lib/client/jet-hub.js` 存在（见 2.5） |
| 侧栏没有额度挂件 | `dsh-credits-widget` 未装或未进 `bundles`（见 2.3 / 2.4） |
| 挂件显示「不支持」/ 读不到数据 | `dsh-codearts-auth` 未装或未登录账号；挂件依赖前者提供数据 |
| 登录窗口没弹出 | 未找到 Chrome/Edge（见 1.1）；或隔离启动失败已回退默认浏览器 |
| 多账号切换仍用同一个号 | 登录时复用了日常浏览器登录态。删掉该账号，用隔离浏览器重登 |
| 请求报限流 / `code:6004` | 正常，等待重置或让插件自动换号；状态灯看 🔴 的账号剩余重置时间 |
| 升级插件到最新 | 重新执行 2.2 / 2.3 的 `add` 命令即可拉取并重建 |

---

## 7. 本手册已验证 / 未验证的边界

**已在本机实测验证**（Node 24.13.0 / pnpm 11.7.0 / dsh 0.1.5-rc.1）：

- 两个插件**从 GitHub 直接 `pnpm add` 安装成功**（在独立临时目录跑通，
  非沿用本机已有安装），`prepare` 自动完成 `lib/` 构建
- 产物路径全部确认存在：`lib/index.js`、`lib/client/jet-hub.js`、
  `lib/isolated-browser.js`（auth）与 `lib/index.js`、`lib/client/index.js`（widget）
- `allowBuilds` 必须带 commit SHA，且 pnpm 会打印可直接粘贴的整行——**已实测复现该报错**
- `dsh plugin --profile web add <git-url>` 确实等价于在 profile 目录跑 pnpm
- 登录依赖本机 Chrome/Edge 的查找路径（源码中确认）
- 反代本体单元测试 455 项全部通过；挂件测试套件全部通过

**未验证**（换机后可能需微调，遇到请**如实报告**而非猜测）：

- **本机实测走的是 `gh-proxy.com` 镜像前缀**（本机直连 GitHub 曾被 reset）。
  未测过新机器直连 `https://github.com/...` 是否畅通。**先用直连试**，
  卡住或连接重置再换镜像前缀：
  `https://gh-proxy.com/https://github.com/elavita/dsh-codearts-auth.git`
- 全新机器上 `pnpm-workspace.yaml` 的**初始内容**——不同 DSH 版本可能不同。
  以新机器实际生成的为准，**不要照抄本手册的整段内容**。
- `dsh.profile.bundles` 是否 100% 自动追加。本机环境是自动的；若否，按 2.4 手工补。
- **浏览器登录全流程**未在全新机器上端到端跑过（需要真人账号，
  无法自动化验证）。隔离浏览器启动、凭据收取等环节已在本机日常使用中工作，
  但"零基础新机器第一次登录"未复现。

---

## 8. 附：本机参考配置（**示例，勿照抄**）

以下是本机 `settings.yaml` 中与插件相关的**结构**，仅用于对照字段含义。
**其中不含任何真实凭据**——凭据本体存在 DSH 的 credential store，账号条目
只保存一个 `credentialRef` 引用名。

```yaml
agent-default-model:
  provider: workbuddy
  model: deepseek-v4.1-flash
jet-hub:
  accounts:
    - id: workbuddy-xxxxxxxx
      provider: workbuddy          # 或 buddy / codearts
      nickname: <账号昵称>
      enabled: true
      credentialRef: WORKBUDDY_ACCOUNT_XXXXXXXX   # 仅引用，非凭据本体
      refreshable: true
  disabledModels: {}               # 模型黑名单：记录且为 true 才隐藏
```

> 新机器**不要**复制 `accounts` 段——账号由第 4 步登录产生。
> 复制了别人的 `credentialRef` 只会得到一个指向不存在凭据的空引用。
