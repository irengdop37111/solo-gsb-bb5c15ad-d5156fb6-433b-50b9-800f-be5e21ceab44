import type { PersistedState } from '../../shared/model';

const LS_KEY = 'clause-reference-validator:v1';

/** localStorage 持久化（主）；服务器文件存储为可选镜像 */
export const localStore = {
  load(): PersistedState | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed.doc || !Array.isArray(parsed.doc.root)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  save(state: PersistedState): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // 存储空间不足等情况下静默失败，界面仍可使用
    }
  },
  clear(): void {
    localStorage.removeItem(LS_KEY);
  },
};

/**
 * 服务器侧文件存储镜像（失败时降级为仅本地浏览器存储）。
 *
 * 连续编辑时上层以约 0.6 秒防抖多次调用 save()。这里保证：
 *  1. 同一时刻只有一个 PUT 在飞（串行提交，严格按调用顺序）；
 *  2. 上一请求发送期间产生的修改合并为“最新待写状态”，请求结束后
 *     只发送最新一次完整状态——中间状态不覆盖更新的状态；
 *  3. 最终成功落盘的必然是最后一次提交的完整状态；
 *  4. 单次失败做有限退避重试；持续失败则放弃本轮并回到空闲，
 *     下一次 save() 仍可继续（本地 localStorage 始终即时保存）。
 */

type SaveResult = boolean;

const SAVE_RETRY_LIMIT = 3; // 含首次共 3 次尝试
const SAVE_RETRY_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ServerStateQueue {
  /** 最新待写状态；正在发送时又有新提交则放在这里，发送结束后补发 */
  private pending: PersistedState | null = null;
  /** 是否有 PUT 在飞 / 等待重试中 */
  private draining = false;

  async save(state: PersistedState): Promise<SaveResult> {
    this.pending = state;
    if (this.draining) {
      // 合并到在飞批次：其结束时会携带本次最新状态再提交一次
      return true;
    }
    this.draining = true;
    try {
      // 持续排空：每轮发送当时最新的待写状态，成功后若期间又有新提交则继续
      for (;;) {
        const next: PersistedState | null = this.pending;
        if (!next) break;
        const ok = await this.putWithRetry(next);
        if (ok) {
          // 只有待写状态仍是本轮发送的这份（期间没有更新的提交）才算排空完成；
          // 若期间又有更新状态，则继续发送更新的状态，保证最终落盘为最新状态
          if (this.pending === next) {
            this.pending = null;
            break;
          }
        } else if (this.pending === next) {
          // 最新状态持续失败：放弃本轮（本地 localStorage 仍即时生效），回到空闲；
          // 后续新的 save() 会重新开始发送
          this.pending = null;
          return false;
        }
        // 旧状态失败但等待期间已有更新状态待写：继续尝试更新的状态
      }
      return true;
    } finally {
      this.draining = false;
    }
  }

  /** 带有限退避重试的 PUT；重试等待期间若已有更新状态待写，旧状态不再重试 */
  private async putWithRetry(state: PersistedState): Promise<boolean> {
    for (let attempt = 1; attempt <= SAVE_RETRY_LIMIT; attempt += 1) {
      const ok = await this.putOnce(state);
      if (ok) return true;
      if (attempt < SAVE_RETRY_LIMIT) {
        await delay(SAVE_RETRY_DELAY_MS * attempt);
        if (this.pending !== state) return false; // 等待期间来了更新状态，由外层发送更新的
      }
    }
    return false;
  }

  private async putOnce(state: PersistedState): Promise<boolean> {
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const serverStore = {
  queue: new ServerStateQueue(),

  async load(): Promise<PersistedState | null> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return null;
      const data = (await res.json()) as { state: PersistedState | null };
      return data.state;
    } catch {
      return null;
    }
  },
  /** 按提交顺序串行同步；在飞期间的多次提交合并为最新待写状态 */
  save(state: PersistedState): Promise<boolean> {
    return this.queue.save(state);
  },
};
