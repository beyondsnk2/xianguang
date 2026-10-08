import { type Cell, type GameConfig, type GameState, type TaskDef, type Task } from '../game/types';
import { pathToNode } from '../game/graph';
import type { Graph } from '../game/graph';
import { fmtDur, itemName } from './format';
import { BLUEPRINT_MIN_FAVOR, BLUEPRINT_MIN_QUALITY, rareCountByEval } from '../game/constants';

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
          '<div class="task-head">' +
            '<span class="cls-tag"></span>' +
            '<span class="task-title"></span>' +
            '<span class="task-right"></span>' +
          '</div>' +
          '<div class="task-fields"></div>' +
          '<div class="task-progress"><i></i></div>';
        this.bindDrag(el, i);
        this.root.appendChild(el);
        this.cards.push(el);
      }
    }

    // 依次估算路程：从当前位置出发，接着以上一个任务点为起点
    let cursor: Cell = { ...state.cell };
    const speed = cfg.values.speed;
    let totalSec = 0; // 当前列表所有任务（含赶路 + 作业）的合计时长

    for (let i = 0; i < n; i++) {
      const slot = state.slots[i];
      const el = this.cards[i];
      const clsEl = el.querySelector('.cls-tag') as HTMLElement;
      const titleEl = el.querySelector('.task-title') as HTMLElement;
      const rightEl = el.querySelector('.task-right') as HTMLElement;
      const fieldsEl = el.querySelector('.task-fields') as HTMLElement;
      const progEl = el.querySelector('.task-progress') as HTMLElement;
      const progBar = progEl.querySelector('i') as HTMLElement;

      el.classList.remove('cls-A', 'cls-B', 'cls-C', 'locked', 'draggable', 'empty', 'drag-over');
      progEl.style.display = 'none';
      fieldsEl.innerHTML = '';

      if (slot.kind === 'empty') {
        el.classList.add('empty');
        el.draggable = false;
        clsEl.textContent = '';
        titleEl.textContent = '空槽 · 补充中';
        rightEl.textContent = `新任务将在 ${fmtDur(slot.refillIn)} 后到达`;
        progEl.style.display = 'block';
        progBar.style.width = `${Math.max(0, Math.min(100, (1 - slot.refillIn / 180) * 100))}%`;
        continue;
      }

      const task = slot.task;
      const def = cfg.taskByTag[task.taskTag];
      const node = cfg.nodeByTag[task.nodeTag];
      const cityName = cfg.cityByTag[task.cityTag]?.name ?? task.cityTag;
      const locked = state.currentTaskId === task.id;
      // 类别角标：采=A采集 / 制=B制造 / 人=C人物
      const clsChar = def?.cls === 'A' ? '采' : def?.cls === 'B' ? '制' : def?.cls === 'C' ? '人' : '';
      el.classList.add(`cls-${def?.cls ?? 'A'}`);

      clsEl.textContent = clsChar;
      titleEl.innerHTML = `<span class="city">${cityName}</span> · ${def?.nodeName ?? node?.name ?? ''} · ${def?.name ?? task.taskTag}`;
      // 结构化字段块：按 A/B/C 类别渲染各自关键信息的「标签芯片 + 值」，语法统一（视觉一致）
      fieldsEl.innerHTML = this.buildFields(def, task, state, cfg);

      // 统一计算该任务的"赶路 + 作业"时长，并沿路径推进光标（队首也计入）
      const p = pathToNode(graph, cursor, task.nodeTag);
      const dist = p?.cost ?? 0;
      const travelSec = dist * speed;
      totalSec += travelSec + task.needTime;
      if (p && p.cells.length) cursor = { ...p.cells[p.cells.length - 1] };

      if (locked) {
        el.classList.add('locked');
        el.draggable = false;
        const ph = state.phase;
        if (ph.kind === 'moving') {
          rightEl.textContent = `赶路中 · 剩余 ${fmtDur(ph.remain)}`;
          progEl.style.display = 'block';
          progBar.style.width = `${ph.total > 0 ? (1 - ph.remain / ph.total) * 100 : 100}%`;
        } else if (ph.kind === 'working') {
          rightEl.textContent = `作业中 · ${ph.label} 剩余 ${fmtDur(ph.remain)}`;
          progEl.style.display = 'block';
          progBar.style.width = `${ph.total > 0 ? (1 - ph.remain / ph.total) * 100 : 100}%`;
        } else {
          rightEl.textContent = '即将出发';
        }
      } else {
        el.classList.add('draggable');
        el.draggable = true;
        rightEl.textContent = `路程 ${dist} 格 · 赶路 ${fmtDur(travelSec)}`;
      }
    }

    // 标题右侧：当前列表所有任务（含赶路 + 作业）的合计时长（以总分钟数呈现）
    // 只更新内层文字节点，避免每帧 textContent 清空把差值气泡一起抹掉
    const totalEl = document.getElementById('board-total');
    if (totalEl) {
      const t = totalEl.querySelector('.board-total-text');
      (t ?? totalEl).textContent = `总时长 ${Math.round(totalSec / 60)} 分钟`;
    }
  }

  /**
   * 按类别构建「标签芯片 + 值」字段块 HTML。
 * - A 采集：产出（材料名 ×产量区间 · 品质，合并为单底框；标题已含材料名，不重复）
 * - B 制造：成品 / 需要图纸（✔已解锁·缺图+缺料，仅高阶任务）
 * - C 人物：好感度（仅 heroTag 命中 10% 概率时显示类别标签，不透露具体武将）/ 稀有（仅 q>=4 且生成时锁定的具体稀有料才显示「名 ×数量」）/ 图纸（仅当图纸门槛全部满足时显示"有机会"，不恒显）
   * 所有字段统一用 .chip 语法渲染，三类视觉一致；hot 取类别色、warn 取警告红、ok 取通过绿。
   * 每个芯片再叠加稀有度类（r-common/r-rare/r-legend，按 def.quality 分档），以底色+内框表达稀有度，不靠文字。
   */
  private buildFields(def: TaskDef | undefined, task: Task, state: GameState, cfg: GameConfig): string {
    if (!def) return '';
    // 稀有度分档（与设计的三品质段一致）：q1-3 普通 / q4-6 稀有 / q7-9 传说。
    // 用「底色 + 内框」表达，不靠文字，也不占用 mod 的边框色（hot/warn/ok 仍正常显示）。
    const rarity = def.quality >= 7 ? 'r-legend' : def.quality >= 4 ? 'r-rare' : 'r-common';
    const chip = (label: string, val?: string, mod?: string) =>
      `<span class="chip ${rarity}${mod ? ' ' + mod : ''}">${label}${val ? ` <b>${val}</b>` : ''}</span>`;
    const parts: string[] = [];
    if (def.cls === 'A') {
      // A 类奖励是「同一个产出」的材料名/产量区间/品质，应合并为单底框，
      // 避免与标题（已含材料名）重复 + 拆成 3 框碎片化。
      const outTag = def.mainOutput || def.getItem || '';
      const range = def.getItemNum ? `${def.getItemNum.min}~${def.getItemNum.max}` : '';
      const name = outTag ? itemName(outTag, cfg) : def.name;
      const q = def.quality > 0 ? `品${def.quality}` : '';
      const val = [range ? '×' + range : '', q].filter(Boolean).join(' · ');
      parts.push(chip('产出', name ? `${name}${val ? ' ' + val : ''}` : val, 'hot'));
    } else if (def.cls === 'B') {
      const outTag = task.outputTag || def.mainOutput || '';
      parts.push(chip('成品', outTag ? itemName(outTag, cfg) : def.name, 'hot'));
      const recipe = outTag ? cfg.recipeByResult[outTag] : null;
      const needBp = recipe?.needBlueprint || null;
      if (needBp && recipe) {
        const has = state.blueprints.includes(needBp);
        parts.push(chip('需要图纸', has ? '✔' : '缺图', has ? 'ok' : 'warn'));
        if (!has) {
          const miss = [recipe.needRare, recipe.needRare2]
            .filter(Boolean)
            .map((r) => itemName(r as string, cfg))
            .join('·');
          if (miss) parts.push(chip('缺', miss, 'warn'));
        }
      }
    } else {
      // C 类产出三类：好感度 / 稀有 / 图纸。
      // 好感度：仅生成时命中 10% 概率锁定的 heroTag 才显示「好感度」类别标签；
      //   具体是哪位武将在生成时即已确定（结算用 task.heroTag），但**任务板上不透露姓名** ——
      //   玩家结算前只知道"此任务含好感奖励"，不知道给谁（保留发现感）。
      // 稀有：仅生成时锁定的具体稀有料（q>=4 才产出）才显示「名 ×数量区间」，否则不显示（避免误导）；
      // 图纸：仅当「图纸门槛」全部满足时才显示 —— 品质≥4 且 累计好感≥30 且 该技能尚有未拥有的图纸。
      //   评价≥佳 为结算时判定（本处不判），故显示芯片仅表示"有机会获得图纸"，不承诺必得（避免恒显误导）。
      if (task.heroTag) parts.push(chip('好感度', undefined, 'hot'));
      if (task.rareTag && cfg.itemByTag[task.rareTag]) {
        // 稀有数量随评价档变化（拙1~绝4），生成时未知评价，故展示区间而非定值
        const lo = rareCountByEval(0);
        const hi = rareCountByEval(3);
        parts.push(chip('稀有', `${itemName(task.rareTag, cfg)} ×${lo}~${hi}`));
      }
      // 图纸门槛（与 produce.ts settleSocial 一致）：q≥4 ∧ favor≥30 ∧ 该技能有未拥有图纸。
      // 评价≥佳 在结算时才知，故此处不判，仅表示"有机会"。
      if (def.quality >= BLUEPRINT_MIN_QUALITY && state.favor >= BLUEPRINT_MIN_FAVOR) {
        const hasUnowned = cfg.blueprints.some(
          (b) => b.fromSkill === def.skill && !state.blueprints.includes(b.tag),
        );
        if (hasUnowned) parts.push(chip('图纸', undefined, 'ok'));
      }
    }
    return parts.join('');
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

/** 计算当前任务列表（含赶路 + 作业）的合计时长（秒），从当前位置沿路径推进光标 */
export function computeTotalSeconds(state: GameState, cfg: GameConfig, graph: Graph): number {
  let cursor: Cell = { ...state.cell };
  const speed = cfg.values.speed;
  let totalSec = 0;
  for (const slot of state.slots) {
    if (slot.kind !== 'task') continue;
    const p = pathToNode(graph, cursor, slot.task.nodeTag);
    const dist = p?.cost ?? 0;
    totalSec += dist * speed + slot.task.needTime;
    if (p && p.cells.length) cursor = { ...p.cells[p.cells.length - 1] };
  }
  return totalSec;
}

/**
 * 在「总时长」上方弹出时间变化气泡：增（更耗时）显红、减（更高效）显绿。
 * deltaMin = 新总分钟 − 旧总分钟；为 0 时不显示。向上飘移淡出约 1s，结束自动移除。
 */
export function flashTotalDelta(deltaMin: number): void {
  if (!Number.isFinite(deltaMin) || deltaMin === 0) return;
  const host = document.getElementById('board-total');
  if (!host) return;
  host.querySelector('.total-delta')?.remove(); // 避免连续重排时多个气泡重叠
  const bubble = document.createElement('span');
  bubble.className = 'total-delta ' + (deltaMin > 0 ? 'up' : 'down');
  bubble.textContent = (deltaMin > 0 ? '↑ +' : '↓ −') + Math.abs(deltaMin) + ' 分';
  host.appendChild(bubble);
  bubble.addEventListener('animationend', () => bubble.remove());
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
