/** 在凭据过期前提前这么长时间刷新（1 小时，与 IDE 一致）。 */
export const REFRESH_LEAD_MS = 3_600_000
/** 刷新失败后的重试间隔（10 分钟，与 IDE 一致）。 */
export const REFRESH_RETRY_MS = 600_000

/** 距离下次刷新的毫秒数；0 表示"立即"。 */
export function computeRefreshDelayMs(expiresAtMs: number, nowMs: number, leadMs = REFRESH_LEAD_MS): number {
  const triggerAt = expiresAtMs - leadMs
  if (triggerAt <= nowMs) return 0
  return triggerAt - nowMs
}

/** 最小化的静默刷新调度器，失败后重试一次。 */
export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** 为在 `expiresAtMs` 过期的凭据设定下次刷新。 */
  arm(expiresAtMs: number, nowMs = Date.now(), leadMs = REFRESH_LEAD_MS): void {
    this.stop()
    const delay = computeRefreshDelayMs(expiresAtMs, nowMs, leadMs)
    this.timer = setTimeout(() => {
      void this.run()
    }, delay)
    this.timer.unref?.()
  }

  /** 取消任何待处理的刷新。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async run(): Promise<void> {
    try {
      await this.refresh()
    } catch (error) {
      this.onError(error)
      this.timer = setTimeout(() => {
        void this.refresh().catch((retryError) => this.onError(retryError))
      }, REFRESH_RETRY_MS)
      this.timer.unref?.()
    }
  }
}
