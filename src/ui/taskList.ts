import { type Cell, type GameConfig, type GameState, type TaskDef, type Task } from '../game/types';
import { pathToNode } from '../game/graph';
import type { Graph } from '../game/graph';
import { fmtDur, itemName } from './format';
import { BLUEPRINT_MIN_QUALITY, BLUEPRINT_NODES, rareCountByEval } from '../game/constants';
import { ownedCount } from '../game/inventory';
import { buyPrice, getDemand } from '../game/economy';
import { skillTier } from '../game/skill';

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
 * - B 制造：成品(hot) / 门槛层[图纸✔·缺图 / 主料×K ✔·缺 / 主稀 ✔·缺]（红=卡住零产出）/ 加成层[额外料×K ✔·缺 / 额外稀 ✔·缺]（中性=少产不拦工）；齐备按「库存≥每件需求」判定
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
      // B 类 = 制造。配方分两层，面板也分层显示，直接回答「材料齐备吗」「有额外料吗」。
      // 门槛层（缺则零产出）：图纸 + 基础主料(needItem1×needItem1Num) + 基础稀有(needRare)
      // 加成层（缺则少产、不拦开工）：额外辅料(needItem2×needItem2Num) + 额外稀有(needRare2)
      // E3 自动补货（仅材料，红线⑦ 不补稀有；全有或全无）：主料/额外料不够且金币够买全部缺口 → 显「补」(ok)并标耗金；
      //   否则维持「缺」(warn)，且不显额外料信息。主稀/额外稀是稀有，永不自动买 → 缺=真卡点。
      // 齐备判定用「库存 ≥ 名义每件需求」(≥1 件即可开工)，与结算买入口径一致（面板金价=实际支出）。
      const outTag = task.outputTag || def.mainOutput || '';
      parts.push(chip('成品', outTag ? itemName(outTag, cfg) : def.name, 'hot'));
      const recipe = outTag ? cfg.recipeByResult[outTag] : null;
      if (recipe) {
        const demand = getDemand(cfg);
        const need1 = recipe.needItem1Num || 1;
        const need2 = recipe.needItem2Num || 1;
        const have1 = recipe.needItem1 ? ownedCount(state, recipe.needItem1) : Infinity;
        const have2 = recipe.needItem2 ? ownedCount(state, recipe.needItem2) : Infinity;
        const rareHave = recipe.needRare ? ownedCount(state, recipe.needRare) : Infinity;
        const buyMat = recipe.needItem1 ? Math.max(0, need1 - have1) : 0;
        const buyMat2 = recipe.needItem2 ? Math.max(0, need2 - have2) : 0;
        const priceMat = recipe.needItem1 ? buyPrice(cfg, demand, task.cityTag, recipe.needItem1) : 0;
        const priceMat2 = recipe.needItem2 ? buyPrice(cfg, demand, task.cityTag, recipe.needItem2) : 0;
        // 主料能买就买（自身全有或全无）；额外料独立判断，买不起则跳过 bonus、不拦工
        const baseCraftable = rareHave >= 1; // 主稀齐备（稀有不可买，缺=真卡点）
        const costMat = buyMat > 0 && priceMat > 0 ? buyMat * priceMat : 0;
        const costMat2 = buyMat2 > 0 && priceMat2 > 0 ? buyMat2 * priceMat2 : 0;
        const buyMain = baseCraftable && costMat > 0 && state.money >= costMat;
        const matSecured = have1 >= need1 || buyMain;
        const buyExtra = matSecured && costMat2 > 0 && state.money >= costMat2;
        const goldCost = (buyMain ? costMat : 0) + (buyExtra ? costMat2 : 0);
        const craftWillHappen = baseCraftable && matSecured;
        // 门槛层：图纸
        if (recipe.needBlueprint) {
          const hasBp = state.blueprints.includes(recipe.needBlueprint);
          parts.push(chip('图纸', hasBp ? '✔' : '缺图', hasBp ? 'ok' : 'warn'));
        }
        // 门槛层：基础主料（缺则零产出 → warn 红；金币够买主料 → 补 ok 绿）
        if (recipe.needItem1) {
          const name = itemName(recipe.needItem1, cfg);
          if (have1 >= need1) parts.push(chip('主料', `${name} ×${need1} ✔`, 'ok'));
          else if (buyMain) parts.push(chip('主料', `${name} ×${need1} 补`, 'ok'));
          else parts.push(chip('主料', `${name} ×${need1} 缺`, 'warn'));
        }
        // 门槛层：基础稀有（缺则零产出 → warn 红；稀有永不自动买，缺=真卡点）
        if (recipe.needRare) {
          const ok = rareHave >= 1;
          parts.push(chip('主稀', `${itemName(recipe.needRare, cfg)}${ok ? ' ✔' : ' 缺'}`, ok ? 'ok' : 'warn'));
        }
        // 加成层：仅当任务确能造（主稀齐备 + 主料已解决）才显示，否则信息无意义
        if (recipe.needItem2 && craftWillHappen) {
          const name = itemName(recipe.needItem2, cfg);
          if (have2 >= need2) parts.push(chip('额外料', `${name} ×${need2} ✔`, 'ok'));
          else if (buyExtra) parts.push(chip('额外料', `${name} ×${need2} 补`, 'ok'));
          else parts.push(chip('额外料', `${name} ×${need2} 缺`)); // 中性：bonus 跳过，不拦工
        }
        // 加成层：额外稀有（同理，主动跳过不拦工）
        if (recipe.needRare2 && craftWillHappen) {
          const ok = ownedCount(state, recipe.needRare2) >= 1;
          parts.push(chip('额外稀', `${itemName(recipe.needRare2, cfg)}${ok ? ' ✔' : ' 缺'}`)); // 中性
        }
        // 金币消耗提示（在额外料之后；仅当本次会触发自动补货）
        if (goldCost > 0) parts.push(`<span class="chip cost">耗金 <b>${goldCost}</b>文</span>`);
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
      // 图纸门槛（**必须与 produce.ts settleSocial 同源**：节点制，不是「好感≥30 随机掉」）。
      // 判定：该 C 技能的**下一个节点**已满足「全局好感 × C 技能 tier」⇒ 若本次结算评价≥佳即可解锁。
      // 注意不要用旧的 `state.favor >= BLUEPRINT_MIN_FAVOR`：改节点制后那会把提示恒亮
      // （全局好感两天就破千，远超 30），与真实发放条件严重不符。
      // 评价≥佳 在结算时才知，故此处仍只表示"有机会"，不承诺必得。
      const nextNodeIdx = state.blueprintNode[def.skill] ?? 0;
      const nextNode = BLUEPRINT_NODES[nextNodeIdx];
      if (nextNode && def.quality >= BLUEPRINT_MIN_QUALITY) {
        const cv = state.skills[def.skill];
        const ctier = cv ? skillTier(cv.lv) : 1;
        if (state.favor >= nextNode.minFavor && ctier >= nextNode.minCTier) {
          const hasUnowned = cfg.blueprints.some(
            (b) => b.fromSkill === def.skill && !state.blueprints.includes(b.tag),
          );
          if (hasUnowned) parts.push(chip('图纸', undefined, 'ok'));
        }
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
