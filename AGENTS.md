# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy）两个 LLM provider 路由。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`
- **构建**：`pnpm build`（TypeScript 编译）
- **语言**：TypeScript
- **许可**：MIT

## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：TypeScript `tsc`，编译输出到 `lib/` 目录
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络）
  - `pnpm test:e2e` — 端到端测试（需要线上端点）
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致

## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录 |
| `lib/` | 编译产物（已 gitignore） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |

## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `status()` — 查询凭据状态（configured、source、expiresAt、refreshable）
- `refresh()` — 手动静默续期凭据
- `logout()` — 清除凭据并停止续期定时器

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑
3. 添加单元测试覆盖
4. 执行 `pnpm build` 编译
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造），不依赖网络
- E2E 测试覆盖完整登录流程，需要环境变量 `DSH_CODEARTS_E2E=1` 激活
- 测试文件按约定放在 `tests/unit/` 目录

## LLM Provider 约定

- provider 名称：`codearts` / `buddy`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy`：Bearer access_token + 额外自定义头
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
