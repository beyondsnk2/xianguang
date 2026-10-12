import { type Cell, type GameConfig, type GameState, type TaskDef, type Task } from '../game/types';
import { vpathFromPoint, type VGraph } from '../game/vgraph';
import { fmtDur, itemName } from './format';
import {
  BLUEPRINT_MIN_EVAL_TIER,
  BLUEPRINT_MIN_QUALITY,
  BLUEPRINT_NODES,
  DEFAULT_EVAL_INC,
  EFF_SAVE_AT_BEST,
  EVAL_NAMES,
  FAVOR_PER_TASK,
  MINGQI_MIN_EVAL_TIER,
  MINGQI_MIN_QUALITY,
  RARE_MIN_QUALITY,
  rareCountByEval,
} from '../game/constants';
import { ownedCount } from '../game/inventory';
import { buyPrice, getDemand } from '../game/economy';
import { skillTier } from '../game/skill';
import { affClassEffect } from '../game/classSystem';

/** 从坐标点出发，沿向量图移动到目标城市的几何路径（坐标模式；无图则视为不可达） */
function vpathTo(
  vg: VGraph | null,
  from: Cell,
  cityTag: string,
): { points: Cell[]; cost: number } | null {
  if (!vg) return null;
  return vpathFromPoint(vg, from, cityTag);
}

export interface BoardCallbacks {
  /** 把第 from 个槽的任务移动到第 to 个位置 */
  onReorder: (from: number, to: number) => void;
}

/**
 * 任务板：7 个槽的 DOM 列表 + HTML5 拖拽排序。
 * 队首（正在执行 / 移动中）锁定，不可拖动；空槽不可拖动。
 *
 * V？ 重构：卡片高度统一（min-height 锁高），常驻只留两区——
 *   上 = 任务信息（角标 + 标题，单行省略）
 *   下 = 左「产出」/ 右「路程·赶路」（锁定卡右为进行中状态）
 * 易变且占高度的「材料齐备/四档奖励明细」移入 hover（移动端长按）浮层，
 * 浮层绝对定位、不撑高，避免 A/B/C 三类因芯片数量不同导致高度参差，
 * 也避免 250ms 重渲染下浮层把布局顶动。B 类「缺料=零产出」是致命信号，
 * 常驻留一个小「缺料」红标，完整材料明细进浮层。
 */
export class TaskBoard {
  private cards: HTMLElement[] = [];
  private dragging = false;
  private layerEl: HTMLElement | null = null;
  private activeIdx = -1;

  constructor(
    private root: HTMLElement,
    private cb: BoardCallbacks,
  ) {}

  update(state: GameState, cfg: GameConfig, vgraph: VGraph | null): void {
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
            '<span class="task-blocked"></span>' +
          '</div>' +
          '<div class="task-foot">' +
            '<span class="task-out"></span>' +
            '<span class="task-dist"></span>' +
          '</div>' +
          '<div class="task-detail"></div>' +
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
      const blockedEl = el.querySelector('.task-blocked') as HTMLElement;
      const outEl = el.querySelector('.task-out') as HTMLElement;
      const distEl = el.querySelector('.task-dist') as HTMLElement;
      const detailEl = el.querySelector('.task-detail') as HTMLElement;
      const progEl = el.querySelector('.task-progress') as HTMLElement;
      const progBar = progEl.querySelector('i') as HTMLElement;

      el.classList.remove('cls-A', 'cls-B', 'cls-C', 'locked', 'draggable', 'empty', 'drag-over', 'detail-up');
      progEl.style.display = 'none';
      blockedEl.classList.remove('on');
      outEl.innerHTML = '';
      detailEl.innerHTML = '';

      if (slot.kind === 'empty') {
        el.classList.add('empty');
        el.draggable = false;
        clsEl.textContent = '';
        titleEl.textContent = '空槽 · 补充中';
        distEl.innerHTML = `<span>补充中</span><span>${fmtDur(slot.refillIn)} 后到达</span>`;
        progEl.style.display = 'block';
        progBar.style.width = `${Math.max(0, Math.min(100, (1 - slot.refillIn / 180) * 100))}%`;
        if (this.activeIdx === i) this.hideDetail();
        continue;
      }

      const task = slot.task;
      const def = cfg.taskByTag[task.taskTag];
      const cityName = cfg.cityByTag[task.cityTag]?.name ?? task.cityTag;
      const locked = state.currentTaskId === task.id;
      // 类别角标：采=A采集 / 制=B制造 / 人=C人物
      const clsChar = def?.cls === 'A' ? '采' : def?.cls === 'B' ? '制' : def?.cls === 'C' ? '人' : '';
      el.classList.add(`cls-${def?.cls ?? 'A'}`);
      clsEl.textContent = clsChar;
      titleEl.innerHTML = `<span class="city">${cityName}</span> · ${def?.nodeName ?? ''} · ${def?.name ?? task.taskTag}`;

      const card = this.buildCard(def, task, state, cfg);
      outEl.innerHTML = card.out;
      detailEl.innerHTML = card.detail;
      if (i === this.activeIdx) this.refreshActive();
      if (card.blocked) {
        blockedEl.classList.add('on');
        blockedEl.textContent = '缺料';
      }

      // 统一计算该任务的"赶路 + 作业"时长，并沿路径推进光标（队首也计入）
      const p = vpathTo(vgraph, cursor, task.cityTag);
      const dist = p?.cost ?? 0;
      const travelSec = dist * speed;
      totalSec += travelSec + task.needTime;
      if (p && p.points.length) cursor = { ...p.points[p.points.length - 1] };

      if (locked) {
        el.classList.add('locked');
        el.draggable = false;
        const ph = state.phase;
        if (ph.kind === 'moving') {
          distEl.innerHTML = `<span>赶路中</span><span>剩余 ${fmtDur(ph.remain)}</span>`;
          progEl.style.display = 'block';
          progBar.style.width = `${ph.total > 0 ? (1 - ph.remain / ph.total) * 100 : 100}%`;
        } else if (ph.kind === 'working') {
          distEl.innerHTML = `<span>作业中 · ${ph.label}</span><span>剩余 ${fmtDur(ph.remain)}</span>`;
          progEl.style.display = 'block';
          progBar.style.width = `${ph.total > 0 ? (1 - ph.remain / ph.total) * 100 : 100}%`;
        } else {
          distEl.innerHTML = '<span>即将出发</span>';
        }
      } else {
        el.classList.add('draggable');
        el.draggable = true;
        distEl.innerHTML = `<span>路程 ${dist} 格</span><span>赶路 ${fmtDur(travelSec)}</span>`;
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
   * 构建单张卡的常驻「产出」+ hover「四档奖励明细/材料齐备」内容。
   * - A 采集：常驻=产出（材料×区间·品q）；浮层=四档数量区间（×评价乘率）。
   * - B 制造：常驻=成品；浮层=四档省料% + 材料齐备/缺/补/耗金（缺料→常驻红标）。
   * - C 人物：常驻=好感度/稀有/图纸（图纸按实时资格判定，满足即亮，外部可见）；
   *          浮层=四档好感值/稀有件数/图纸/名品机会。
   * 所有芯片统一 .chip 语法，三类视觉一致；稀有度类仅作用于常驻产出芯片。
   */
  private buildCard(
    def: TaskDef | undefined,
    task: Task,
    state: GameState,
    cfg: GameConfig,
  ): { out: string; detail: string; blocked: boolean } {
    if (!def) return { out: '', detail: '', blocked: false };
    // 稀有度分档（与设计的三品质段一致）：q1-3 普通 / q4-6 稀有 / q7-9 传说。
    // 用「底色 + 内框」表达，不靠文字，也不占用 mod 的边框色（hot/warn/ok 仍正常显示）。
    const rarity = def.quality >= 7 ? 'r-legend' : def.quality >= 4 ? 'r-rare' : 'r-common';
    const chip = (label: string, val?: string, mod?: string) =>
      `<span class="chip ${rarity}${mod ? ' ' + mod : ''}">${label}${val ? ` <b>${val}</b>` : ''}</span>`;
    const inc = def.evalInc && def.evalInc.length === 4 ? def.evalInc : DEFAULT_EVAL_INC;
    const q = def.quality;
    const out: string[] = [];
    let detail = '';
    let blocked = false;

    if (def.cls === 'A') {
      // A 类奖励是「同一个产出」的材料名/产量区间/品质，应合并为单底框，
      // 避免与标题（已含材料名）重复 + 拆成 3 框碎片化。
      const outTag = def.mainOutput || def.getItem || '';
      const range = def.getItemNum ? `${def.getItemNum.min}~${def.getItemNum.max}` : '';
      const name = outTag ? itemName(outTag, cfg) : def.name;
      const qq = q > 0 ? `品${q}` : '';
      const val = [range ? '×' + range : '', qq].filter(Boolean).join(' · ');
      out.push(chip('产出', name ? `${name} ${val}` : val, 'hot'));
      // 浮层：四档数量区间 = 保底范围 × 评价乘率 × 职业产出加成
      const baseMin = def.getItemNum?.min ?? 1;
      const baseMax = def.getItemNum?.max ?? baseMin;
      const mul = 1 + affClassEffect(state, cfg, def.skill, 'gatherYield');
      detail = this.detailHead() + this.tdGrid((t) => {
        const m = 1 + inc[t];
        const lo = Math.max(1, Math.floor(baseMin * m * mul));
        const hi = Math.max(1, Math.floor(baseMax * m * mul));
        return `<span>${lo === hi ? lo : `${lo}~${hi}`} 件</span>`;
      });
    } else if (def.cls === 'B') {
      // B 类 = 制造。常驻只放成品；材料齐备/缺/补/耗金进浮层。
      const outTag = task.outputTag || def.mainOutput || '';
      out.push(chip('成品', outTag ? itemName(outTag, cfg) : def.name, 'hot'));
      const r = this.bReadiness(def, task, state, cfg);
      blocked = r.blocked;
      // 浮层：四档省料%（绝档 = EFF_SAVE_AT_BEST + 职业加成，封顶）
      const craftSave = affClassEffect(state, cfg, def.skill, 'craftSave');
      detail =
        this.detailHead() +
        this.tdGrid((t) => {
          const m = 1 + inc[t];
          const save = Math.round((EFF_SAVE_AT_BEST + craftSave) * Math.min(1, Math.max(0, m - 1)) * 100);
          return `<span>省料 ${save}%</span>`;
        }) +
        (r.html ? `<div class="td-sub">材料齐备</div>${r.html}` : '');
    } else {
      // C 类产出三类：好感度 / 稀有 / 图纸。
      // 好感度：仅生成时命中 10% 概率锁定的 heroTag 才显示「好感度」类别标签（不透露具体武将）。
      // 稀有：仅 q>=4 且生成时锁定的具体稀有料才显示「名 ×数量区间」。
      // 图纸：按实时资格（q≥4 ∧ favor/ctier 达标 ∧ 仍有未学图纸）判定，满足即常驻显示"是否给图纸"。
      if (task.heroTag) out.push(chip('好感度', undefined, 'hot'));
      if (task.rareTag && cfg.itemByTag[task.rareTag]) {
        const lo = rareCountByEval(0);
        const hi = rareCountByEval(3);
        out.push(chip('稀有', `${itemName(task.rareTag, cfg)} ×${lo}~${hi}`));
      }
      const nextNodeIdx = state.blueprintNode[def.skill] ?? 0;
      const nextNode = BLUEPRINT_NODES[nextNodeIdx];
      if (nextNode && q >= BLUEPRINT_MIN_QUALITY) {
        const cv = state.skills[def.skill];
        const ctier = cv ? skillTier(cv.lv) : 1;
        if (state.favor >= nextNode.minFavor && ctier >= nextNode.minCTier) {
          const hasUnowned = cfg.blueprints.some(
            (b) => b.fromSkill === def.skill && !state.blueprints.includes(b.tag),
          );
          if (hasUnowned) out.push(chip('图纸', undefined, 'ok'));
        }
      }
      // 浮层：四档好感值 / 稀有件数 / 图纸·名品机会
      const socialFavor = affClassEffect(state, cfg, def.skill, 'socialFavor');
      detail = this.detailHead() + this.tdGrid((t) => {
        const favor = Math.round((FAVOR_PER_TASK + Math.max(0, q) + t) * (1 + socialFavor));
        const rare = q >= RARE_MIN_QUALITY ? rareCountByEval(t) : 0;
        let s = `<span>好感 ${favor}</span>`;
        if (rare) s += `<span>稀 ${rare}</span>`;
        if (t >= BLUEPRINT_MIN_EVAL_TIER) s += `<span class="td-y">图纸</span>`;
        if (t >= MINGQI_MIN_EVAL_TIER && q >= MINGQI_MIN_QUALITY) s += `<span class="td-y">名品?</span>`;
        return s;
      });
    }
    return { out: out.join(''), detail, blocked };
  }

  /**
   * B 类材料齐备判定（与 produce.ts settleCraft 同源口径）。
   * 返回可读芯片 HTML 与是否「致命卡住」（主稀缺或主料/补货仍不足 → 零产出）。
   */
  private bReadiness(def: TaskDef, task: Task, state: GameState, cfg: GameConfig): { html: string; blocked: boolean } {
    const outTag = task.outputTag || def.mainOutput || '';
    const recipe = outTag ? cfg.recipeByResult[outTag] : null;
    if (!recipe) return { html: '', blocked: false };
    // 一种材料一行；需金币补货的行，行右显示补齐缺口的耗金（仅主料/额外料可自动补）
    const row = (name: string, status: string, mod: 'ok' | 'warn' | 'mid', gold = 0) =>
      `<div class="mt-row"><span class="mt-name">${name}</span>` +
      `<span class="mt-status ${mod}">${status}</span>` +
      (gold > 0 ? `<span class="mt-gold">耗金 ${gold}文</span>` : '') +
      `</div>`;
    const parts: string[] = [];
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
    const craftWillHappen = baseCraftable && matSecured; // 缺则零产出
    const blocked = !craftWillHappen;

    // 门槛层：图纸
    if (recipe.needBlueprint) {
      const hasBp = state.blueprints.includes(recipe.needBlueprint);
      parts.push(row('图纸', hasBp ? '✔' : '缺图', hasBp ? 'ok' : 'warn'));
    }
    // 门槛层：基础主料（缺则零产出 → warn 红；金币够买主料 → 补 ok 绿 + 行右耗金）
    if (recipe.needItem1) {
      const name = itemName(recipe.needItem1, cfg);
      if (have1 >= need1) parts.push(row(`主料 ${name} ×${need1}`, '✔', 'ok'));
      else if (buyMain) parts.push(row(`主料 ${name} ×${need1}`, '补', 'ok', costMat));
      else parts.push(row(`主料 ${name} ×${need1}`, '缺', 'warn'));
    }
    // 门槛层：基础稀有（缺则零产出 → warn 红；稀有永不自动买，缺=真卡点）
    if (recipe.needRare) {
      const ok = rareHave >= 1;
      parts.push(row(`主稀 ${itemName(recipe.needRare, cfg)}`, ok ? '✔' : '缺', ok ? 'ok' : 'warn'));
    }
    // 加成层：仅当任务确能造（主稀齐备 + 主料已解决）才显示，否则信息无意义
    if (recipe.needItem2 && craftWillHappen) {
      const name = itemName(recipe.needItem2, cfg);
      if (have2 >= need2) parts.push(row(`额外料 ${name} ×${need2}`, '✔', 'ok'));
      else if (buyExtra) parts.push(row(`额外料 ${name} ×${need2}`, '补', 'ok', costMat2));
      else parts.push(row(`额外料 ${name} ×${need2}`, '缺', 'mid')); // 中性：bonus 跳过，不拦工
    }
    // 加成层：额外稀有（同理，主动跳过不拦工）
    if (recipe.needRare2 && craftWillHappen) {
      const ok = ownedCount(state, recipe.needRare2) >= 1;
      parts.push(row(`额外稀 ${itemName(recipe.needRare2, cfg)}`, ok ? '✔' : '缺', ok ? 'ok' : 'mid'));
    }
    return { html: parts.join(''), blocked };
  }

  private detailHead(): string {
    return `<div class="td-head">评价四档产出</div>`;
  }

  /** 四档（拙/平/佳/绝）各生成一列，列内由 fn(tier) 返回若干 <span> 行 */
  private tdGrid(fn: (t: number) => string): string {
    return (
      `<div class="td-grid">` +
      [0, 1, 2, 3].map((t) => `<div class="td-col"><b>${EVAL_NAMES[t]}</b>${fn(t)}</div>`).join('') +
      `</div>`
    );
  }

  /** 全局浮层（脱离侧栏裁剪，悬于地图左侧，不盖住上下任务卡） */
  private ensureLayer(): HTMLElement {
    if (!this.layerEl) {
      const el = document.createElement('div');
      el.className = 'task-detail-layer';
      el.style.display = 'none';
      document.body.appendChild(el);
      this.layerEl = el;
    }
    return this.layerEl;
  }

  private showDetail(index: number): void {
    const el = this.cards[index];
    if (!el) return;
    const src = el.querySelector('.task-detail') as HTMLElement | null;
    const html = src?.innerHTML ?? '';
    if (!html.trim()) {
      this.hideDetail();
      return;
    }
    const layer = this.ensureLayer();
    layer.innerHTML = `<div class="task-detail-pop">${html}</div>`;
    el.classList.add('show-detail');
    this.activeIdx = index;
    layer.style.display = 'block';
    this.positionLayer(el);
  }

  private hideDetail(): void {
    if (this.activeIdx >= 0 && this.cards[this.activeIdx]) {
      this.cards[this.activeIdx].classList.remove('show-detail');
    }
    if (this.layerEl) this.layerEl.style.display = 'none';
    this.activeIdx = -1;
  }

  /** 浮层定在卡片左侧（地图区），左侧空间不足则翻到右侧；垂直方向夹在视口内 */
  private positionLayer(el: HTMLElement): void {
    const layer = this.layerEl;
    const pop = layer?.firstElementChild as HTMLElement | null;
    if (!layer || !pop) return;
    const rect = el.getBoundingClientRect();
    const popW = pop.offsetWidth || 300;
    let left = rect.left - popW - 10;
    if (left < 8) left = rect.right + 10;
    const popH = pop.offsetHeight || 120;
    const vh = window.innerHeight;
    let top = rect.top;
    if (top + popH > vh - 8) top = Math.max(8, vh - popH - 8);
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
  }

  /** 250ms 重渲染时，若浮层正展开则同步刷新内容与位置（材料/金币实时变） */
  private refreshActive(): void {
    if (this.activeIdx < 0) return;
    const el = this.cards[this.activeIdx];
    const src = el?.querySelector('.task-detail') as HTMLElement | null;
    const html = src?.innerHTML ?? '';
    if (!el || !src || !this.layerEl || !html.trim()) {
      this.hideDetail();
      return;
    }
    this.layerEl.innerHTML = `<div class="task-detail-pop">${html}</div>`;
    this.positionLayer(el);
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
    // 桌面（hover 设备）：悬停显示浮层
    if (window.matchMedia('(hover: hover)').matches) {
      el.addEventListener('mouseenter', () => this.showDetail(index));
      el.addEventListener('mouseleave', () => this.hideDetail());
    }
    // 移动端：长按 450ms 显示；短按（未触发长按）则收起
    let pressTimer = 0;
    let openedByPress = false;
    el.addEventListener(
      'touchstart',
      () => {
        pressTimer = window.setTimeout(() => {
          this.showDetail(index);
          openedByPress = true;
        }, 450);
      },
      { passive: true },
    );
    const clear = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = 0;
      }
    };
    const onEnd = () => {
      if (openedByPress) {
        openedByPress = false;
        clear();
        return;
      }
      clear();
      this.hideDetail();
    };
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchmove', clear);
    el.addEventListener('touchcancel', clear);
  }
}

/** 计算当前任务列表（含赶路 + 作业）的合计时长（秒），从当前位置沿路径推进光标 */
export function computeTotalSeconds(state: GameState, cfg: GameConfig, vgraph: VGraph | null): number {
  let cursor: Cell = { ...state.cell };
  const speed = cfg.values.speed;
  let totalSec = 0;
  for (const slot of state.slots) {
    if (slot.kind !== 'task') continue;
    const p = vpathTo(vgraph, cursor, slot.task.cityTag);
    const dist = p?.cost ?? 0;
    totalSec += dist * speed + slot.task.needTime;
    if (p && p.points.length) cursor = { ...p.points[p.points.length - 1] };
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
export function autoSort(state: GameState, cfg: GameConfig, vgraph: VGraph | null): void {
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
      const cp = cfg.cityPointByTag[curSlot.task.cityTag];
      if (cp) cursor = { x: cp.x, y: cp.y };
    }
  }
  while (remain.length) {
    let bestK = 0;
    let bestD = Infinity;
    let bestEnd: Cell = cursor;
    for (let k = 0; k < remain.length; k++) {
      const slot = state.slots[remain[k]];
      if (slot.kind !== 'task') continue;
      const p = vpathTo(vgraph, cursor, slot.task.cityTag);
      const d = p?.cost ?? Infinity;
      if (d < bestD) {
        bestD = d;
        bestK = k;
        if (p) bestEnd = { ...p.points[p.points.length - 1] };
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
