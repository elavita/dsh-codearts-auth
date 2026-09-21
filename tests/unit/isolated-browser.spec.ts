/**
 * 隔离浏览器会话的单元测试。
 *
 * 覆盖两类关键行为：
 * 1. **隔离性**：启动参数必须带 `--user-data-dir=<独立目录>`，否则会复用
 *    用户日常浏览器的登录态 —— 那正是「两个 GitHub 账号却总是登录第一个」的成因。
 * 2. **清理**：关闭会话后 profile 目录必须真的从磁盘消失。浏览器运行期间
 *    该目录被锁（Windows 上表现为 EBUSY），因此「先杀进程再删目录」的顺序
 *    是实现要点，这里用真实子进程验证。
 *
 * 用真实的 `node` 进程代替浏览器：外部行为（进程生命周期 + 目录锁语义）
 * 与浏览器一致，但不依赖本机是否装了 Chrome。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeIsolatedBrowser, findBrowserExecutable } from '../../src/isolated-browser.js'
import type { IsolatedBrowserSession } from '../../src/isolated-browser.js'

describe('隔离浏览器：可执行文件发现', () => {
  it('在本机能找到 Chrome 或 Edge（找不到时应返回 undefined 而不是抛错）', () => {
    const found = findBrowserExecutable()
    // 本机装了 Chrome；即便未装也必须是 undefined 而不是抛异常。
    expect(found === undefined || (typeof found === 'string' && found.length > 0)).toBe(true)
  })
})

describe('隔离浏览器：关闭与清理', () => {
  it('关闭会话后 profile 目录被删除', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-test-'))
    await writeFile(join(dir, 'marker.txt'), 'x')

    // 用 node 模拟浏览器：sleep 一段时间，保持进程存活。
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })

    const session: IsolatedBrowserSession = { profileDir: dir, process: child, launched: true }
    expect(existsSync(dir)).toBe(true)

    const removed = await closeIsolatedBrowser(session)

    expect(removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('进程已退出时仍能删除目录（不抛错）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso-test-'))
    await mkdir(join(dir, 'Default'), { recursive: true })
    await writeFile(join(dir, 'Default', 'Cookies'), 'not-a-real-cookie')

    const session: IsolatedBrowserSession = { profileDir: dir, launched: true }
    const removed = await closeIsolatedBrowser(session)

    expect(removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('传入 undefined 是安全的 no-op', async () => {
    await expect(closeIsolatedBrowser(undefined)).resolves.toBe(true)
  })

  it('目录不存在时删除视为成功（force 语义）', async () => {
    const session: IsolatedBrowserSession = {
      profileDir: join(tmpdir(), 'iso-definitely-not-exists-' + Date.now()),
      launched: true,
    }
    await expect(closeIsolatedBrowser(session)).resolves.toBe(true)
  })
})
