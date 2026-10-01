import type { GameState } from './types';
import { SAVE_KEY, SAVE_VERSION } from './constants';

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== SAVE_VERSION) {
      console.warn('[save] 存档结构版本不一致，已重置');
      return null;
    }
    if (typeof parsed.lastTickAt !== 'number' || !Array.isArray(parsed.slots)) return null;
    return parsed;
  } catch (e) {
    console.warn('[save] 读取失败', e);
    return null;
  }
}

export function saveState(state: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[save] 写入失败', e);
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 多标签防互相覆盖：只有一个标签是 active，负责推进与写档；
 * 其余标签停止 tick 与写档，避免后写的覆盖先写的进度。
 */
export class TabLeader {
  readonly id = Math.random().toString(36).slice(2);
  active = false;
  onChange: ((active: boolean) => void) | null = null;

  private ch: BroadcastChannel | null = null;
  private lastLeaderSeen = 0;
  private timer: number | null = null;
  private electing = false;

  start(): void {
    if (typeof BroadcastChannel === 'undefined') {
      this.setActive(true);
      return;
    }
    this.ch = new BroadcastChannel('sanwalk-tab');
    this.ch.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; id: string };
      if (!msg || msg.id === this.id) return;
      if (msg.type === 'hello') {
        if (this.active) this.post('iam');
      } else if (msg.type === 'iam') {
        if (this.active && msg.id > this.id) return; // id 大者优先，保持唯一
        this.lastLeaderSeen = Date.now();
        this.setActive(false);
      } else if (msg.type === 'hb') {
        this.lastLeaderSeen = Date.now();
        if (this.active) return;
        this.setActive(false);
      } else if (msg.type === 'bye') {
        if (!this.active) this.elect();
      }
    };
    this.timer = window.setInterval(() => this.watchdog(), 1500);
    this.elect();
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.post('bye');
    this.ch?.close();
    this.ch = null;
  }

  private post(type: string): void {
    this.ch?.postMessage({ type, id: this.id });
  }

  private elect(): void {
    if (this.electing) return;
    this.electing = true;
    this.post('hello');
    window.setTimeout(() => {
      this.electing = false;
      // 400 ms 内没人认领 leader，则自己上任
      if (!this.active && Date.now() - this.lastLeaderSeen > 400) this.setActive(true);
    }, 400);
  }

  private watchdog(): void {
    if (this.active) {
      this.post('hb');
      return;
    }
    if (Date.now() - this.lastLeaderSeen > 6000) this.elect(); // leader 已关闭，重新选举
  }

  private setActive(v: boolean): void {
    if (this.active === v) return;
    this.active = v;
    this.lastLeaderSeen = Date.now();
    this.onChange?.(v);
  }
}
