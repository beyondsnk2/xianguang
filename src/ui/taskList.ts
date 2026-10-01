import { ATTR_NAMES, type Cell, type GameConfig, type GameState } from '../game/types';
import { pathToNode } from '../game/graph';
import type { Graph } from '../game/graph';
import { fmtDur, itemName } from './format';

export interface BoardCallbacks {
  /** 把第 from 个槽的任务移动到第 to 个位置 */
  onReorder: (from: number, to: number) => void;
}

/**
 * 任务板：7 个槽的 DOM 列表 + HTML5 拖拽排序。
 * 队首（正在执行 / 移动中）锁定，不可拖动；空槽不可拖动。
 */
export class TaskBoard {
  private cards: HTMLElement[] = [];
  private dragging = false;

  constructor(
    private root: HTMLElement,
    private cb: BoardCallbacks,
  ) {}

  update(state: GameState, cfg: GameConfig, graph: Graph): void {
    if (this.dragging) return; // 拖拽过程中不重建，避免打断 HTML5 DnD

    const n = state.slots.length;
    if (this.cards.length !== n) {
      this.root.innerHTML = '';
      this.cards = [];
      for (let i = 0; i < n; i++) {
        const el = document.createElement('div');
        el.className = 'task';
        el.innerHTML =
          '<div class="task-idx"></div>' +
          '<div><div class="task-title"></div><div class="task-sub"></div></div>' +
          '<div class="task-right"></div>' +
          '<div class="task-progress"><i></i></div>';
        this.bindDrag(el, i);
        this.root.appendChild(el);
        this.cards.push(el);
      }
    }

    // 依次估算路程：从当前位置出发，接着以上一个任务点为起点
    let cursor: Cell = { ...state.cell };
    const speed = cfg.values.speed;

    for (let i = 0; i < n; i++) {
      const slot = state.slots[i];
      const el = this.cards[i];
      const idxEl = el.querySelector('.task-idx') as HTMLElement;
      const titleEl = el.querySelector('.task-title') as HTMLElement;
      const subEl = el.querySelector('.task-sub') as HTMLElement;
      const rightEl = el.querySelector('.task-right') as HTMLElement;
      const progEl = el.querySelector('.task-progress') as HTMLElement;
      const progBar = progEl.querySelector('i') as HTMLElement;

      idxEl.textContent = String(i + 1);
      el.classList.remove('locked', 'draggable', 'empty', 'drag-over');
      progEl.style.display = 'none';

      if (slot.kind === 'empty') {
        el.classList.add('empty');
        el.draggable = false;
        titleEl.textContent = '空槽 · 补充中';
        subEl.textContent = `新任务将在 ${fmtDur(slot.refillIn)} 后到达`;
        rightEl.textContent = '';
        progEl.style.display = 'block';
        progBar.style.width = `${Math.max(0, Math.min(100, (1 - slot.refillIn / 180) * 100))}%`;
        continue;
      }

      const task = slot.task;
      const def = cfg.taskByTag[task.taskTag];
      const node = cfg.nodeByTag[task.nodeTag];
      const cityName = cfg.cityByTag[task.cityTag]?.name ?? task.cityTag;
      const locked = state.currentTaskId === task.id;
      const yieldText = def
        ? def.getItem
          ? `${itemName(def.getItem)} × ${def.getItemNum?.min ?? 0}~${def.getItemNum?.max ?? 0}`
          : `${def.getAttrXp ? ATTR_NAMES[def.getAttrXp] : ''}经验 ${def.getAttrXpNum?.min ?? 0}~${def.getAttrXpNum?.max ?? 0}`
        : '';

      titleEl.innerHTML =
        `<span class="city">${cityName}</span> · ${def?.nodeName ?? node?.name ?? ''} · ${def?.name ?? task.taskTag}`;
      rightEl.innerHTML = `<b>${yieldText}</b>`;

      if (locked) {
        el.classList.add('locked');
        el.draggable = false;
        const p = state.phase;
        if (p.kind === 'moving') {
          subEl.textContent = `赶路中 · 剩余 ${Math.ceil(p.remain / speed)} 格 / ${fmtDur(p.remain)}`;
          progEl.style.display = 'block';
          progBar.style.width = `${p.total > 0 ? (1 - p.remain / p.total) * 100 : 100}%`;
        } else if (p.kind === 'working') {
          subEl.textContent = `作业中 · ${p.label} 剩余 ${fmtDur(p.remain)}`;
          progEl.style.display = 'block';
          progBar.style.width = `${p.total > 0 ? (1 - p.remain / p.total) * 100 : 100}%`;
        } else {
          subEl.textContent = '即将出发';
        }
        if (node) cursor = { ...node.cells[0] };
      } else {
        el.classList.add('draggable');
        el.draggable = true;
        const p = pathToNode(graph, cursor, task.nodeTag);
        const dist = p?.cost ?? 0;
        const travelSec = dist * speed;
        subEl.textContent = `路程 ${dist} 格 · 赶路 ${fmtDur(travelSec)} · 作业 ${task.needTime} 秒`;
        if (p && p.cells.length) cursor = { ...p.cells[p.cells.length - 1] };
      }
    }
  }

  private bindDrag(el: HTMLElement, index: number): void {
    el.addEventListener('dragstart', (ev) => {
      this.dragging = true;
      el.style.opacity = '0.45';
      (ev as DragEvent).dataTransfer?.setData('text/plain', String(index));
    });
    el.addEventListener('dragend', () => {
      this.dragging = false;
      el.style.opacity = '1';
    });
    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      el.classList.remove('drag-over');
      const from = Number((ev as DragEvent).dataTransfer?.getData('text/plain') ?? 'NaN');
      if (Number.isFinite(from)) this.cb.onReorder(from, index);
    });
  }
}

/** 贪心最优排序：从当前位置出发，每次取最近的（开发文档 §5.2 建议） */
export function autoSort(state: GameState, cfg: GameConfig, graph: Graph): void {
  const pendingIdx: number[] = [];
  for (let i = 0; i < state.slots.length; i++) {
    const s = state.slots[i];
    if (s.kind === 'task' && s.task.id !== state.currentTaskId) pendingIdx.push(i);
  }
  const remain = pendingIdx.slice();
  const order: number[] = [];
  let cursor: Cell = { ...state.cell };
  const cur = state.currentTaskId;
  if (cur !== null) {
    const curSlot = state.slots.find((s) => s.kind === 'task' && s.task.id === cur);
    if (curSlot && curSlot.kind === 'task') {
      const node = cfg.nodeByTag[curSlot.task.nodeTag];
      if (node) cursor = { ...node.cells[0] };
    }
  }
  while (remain.length) {
    let bestK = 0;
    let bestD = Infinity;
    let bestEnd: Cell = cursor;
    for (let k = 0; k < remain.length; k++) {
      const slot = state.slots[remain[k]];
      if (slot.kind !== 'task') continue;
      const p = pathToNode(graph, cursor, slot.task.nodeTag);
      const d = p?.cost ?? Infinity;
      if (d < bestD) {
        bestD = d;
        bestK = k;
        if (p) bestEnd = { ...p.cells[p.cells.length - 1] };
      }
    }
    order.push(remain[bestK]);
    remain.splice(bestK, 1);
    cursor = bestEnd;
  }
  const picked = order.map((i) => state.slots[i]);
  let w = 0;
  for (const i of pendingIdx) {
    // 只重排「待执行」槽，锁定槽与空槽位置不动
    state.slots[i] = picked[w++];
  }
}
