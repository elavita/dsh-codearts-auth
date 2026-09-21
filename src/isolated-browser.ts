/**
 * 隔离浏览器会话：为「新建账号」打开一个**全新、无任何缓存与登录态**的浏览器实例。
 *
 * ## 为什么需要它
 *
 * 原先打开登录页走的是两条复用当前浏览器会话的路径：
 * - 客户端 `window.open(loginUrl, '_blank')`（`plugin-src/client/jet-hub.js`）
 * - 宿主端 `openBrowser()` 的 `cmd /c start`（走系统默认浏览器）
 *
 * 两者都在**用户日常使用的浏览器**里开标签页：共用同一份 Cookie 与登录态。
 * 于是当 OAuth 提供方（如 GitHub）已登录账号 A 时，授权页会直接沿用 A，
 * 用户**没有任何切换账号的机会** —— 表现为「有两个 GitHub 账号，却总是登录
 * 第一个，无法切换」。
 *
 * ## 解法
 *
 * 用独立 `--user-data-dir` 启动一个全新 profile 的浏览器实例。该实例没有
 * Cookie、没有登录态、没有会话，OAuth 提供方必然要求从头登录 —— 用户就能
 * 自由选择另一个账号。
 *
 * ## 生命周期（实测约束）
 *
 * **浏览器运行期间其 profile 目录被锁定，无法删除**（实测：Chrome 持有
 * `journal.baj`，`Remove-Item` 报 EBUSY）。因此「用完即删」必须分两步：
 *
 * 1. 登录完成/超时/失败后，**先杀掉启动时拿到的 root 进程**；
 *    实测杀掉 root 会带走该实例的全部子进程（11 个 chrome 进程归零）。
 * 2. 子进程退净后才删除 profile 目录。
 *
 * 用户选定「登录成功后立即删除」：保证**每次新建账号都是彻底全新环境**。
 * 代价是每次都要完整走一遍第三方登录（含 2FA），这是刻意的取舍。
 *
 * ## 退出兜底
 *
 * 进程退出时（含异常）由 `process.on('exit')` 同步兜底清理已跟踪的会话，
 * 避免临时目录无限堆积。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

/** 一个隔离浏览器会话。 */
export interface IsolatedBrowserSession {
  /** profile 临时目录（绝对路径）。 */
  profileDir: string
  /** 启动的浏览器进程；未成功启动时为 undefined。 */
  process?: ChildProcess
  /** 是否成功以隔离模式启动（false 表示需回退到默认打开方式）。 */
  launched: boolean
  /** 启动失败原因（已回退时用于日志）。 */
  message?: string
}

/** 已跟踪的会话，供进程退出时兜底清理。 */
const tracked = new Set<IsolatedBrowserSession>()

/** 安装进程退出兜底（幂等）。 */
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    // 退出钩子里只能用同步 API。
    for (const session of tracked) {
      try {
        session.process?.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
      try {
        rmSync(session.profileDir, { recursive: true, force: true })
      } catch {
        /* 仍被占用时留给系统清理临时目录 */
      }
    }
    tracked.clear()
  })
}

/** 候选浏览器可执行文件（按优先级）。仅 Windows 需要显式路径。 */
function candidateExecutables(): string[] {
  if (platform() !== 'win32') return []
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  return [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(localAppData.length > 0 ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
}

/** 找到第一个存在的浏览器可执行文件；都没有时返回 undefined。 */
export function findBrowserExecutable(): string | undefined {
  for (const candidate of candidateExecutables()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 无权限探测时跳过 */
    }
  }
  return undefined
}

/**
 * 以**隔离 profile** 打开 URL。
 *
 * @returns 会话对象。`launched: false` 表示未能以隔离模式启动，调用方应回退
 *   到默认打开方式（并为「可能复用登录态」给出提示）。
 */
export async function openIsolatedBrowser(url: string): Promise<IsolatedBrowserSession> {
  installExitHook()

  let profileDir: string
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'dsh-login-'))
  } catch (error) {
    return {
      profileDir: '',
      launched: false,
      message: `无法创建临时 profile 目录: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const executable = findBrowserExecutable()
  if (executable === undefined) {
    await safeRemove(profileDir)
    return {
      profileDir: '',
      launched: false,
      message: '未找到 Chrome / Edge 可执行文件，无法以隔离模式打开',
    }
  }

  // --new-window 保证不并入任何既有实例；--no-first-run / --no-default-browser-check
  // 避免首次运行向导打断登录。
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ]

  try {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
    // 必须 unref：否则宿主进程会被浏览器子进程拖住无法退出。
    child.unref()
    const session: IsolatedBrowserSession = { profileDir, process: child, launched: true }
    tracked.add(session)
    return session
  } catch (error) {
    await safeRemove(profileDir)
    return {
      profileDir: '',
      launched: false,
      message: `启动隔离浏览器失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 删除目录，失败返回 false（不抛错）。 */
async function safeRemove(dir: string): Promise<boolean> {
  if (dir.length === 0) return true
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 关闭隔离会话并删除其 profile 目录。
 *
 * 顺序不可颠倒：**先杀进程**（否则目录被锁，删除必失败），进程退出后再删目录。
 * 删除失败时会重试若干次 —— Windows 上进程退出与文件句柄释放之间存在短暂窗口。
 *
 * @returns 目录是否已确实删除。
 */
export async function closeIsolatedBrowser(session: IsolatedBrowserSession | undefined): Promise<boolean> {
  if (session === undefined) return true
  tracked.delete(session)

  try {
    session.process?.kill()
  } catch {
    /* 已退出 */
  }

  // 进程退出与句柄释放之间有窗口期；轮询等待而不是固定 sleep。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await safeRemove(session.profileDir)) return true
    await delay(150)
  }
  // 最后一次尝试强杀后再删：某些情况下优雅退出不足以释放锁。
  try {
    session.process?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  await delay(300)
  return safeRemove(session.profileDir)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
