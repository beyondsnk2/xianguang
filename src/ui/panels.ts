import { ATTR_KEYS, ATTR_NAMES, type AttrKey, type GameConfig, type GameState, type StandingDef } from '../game/types';
import {
  activeStandingSlots,
  classProgress,
  getUnlockedClasses,
  isClassUnlocked,
  standingReqMet,
  totalSkillLv,
} from '../game/classSystem';
import { bagCapacity, bagItemCount, bagSlotsUsed, storageItemCount } from '../game/state';
import type { CheckResult } from '../game/selfcheck';
import { esc, fmtClock, fmtDur, itemName } from './format';
import {
  GENERALS,
  REL_STAGES,
  relationStage,
  type Faction,
} from '../game/generals';
import type { GameEvent } from '../game/events';
import {
  describeOptionRewards,
  eventByTag,
  EVENT_TYPE_NAMES,
  JIANWEN_NAMES,
  type AttrGainInfo,
  type EventResult,
  type RewardLine,
  type SkillGainInfo,
} from '../game/event';
import { EVENT_CONTAINER_CAP, EVENT_DAILY_CAP, EVENT_KEEP_MIN } from '../game/constants';

const FACTION_CLS: Record<Faction, string> = {
  魏: 'fac-wei',
  蜀: 'fac-shu',
  吴: 'fac-wu',
  群: 'fac-qun',
};

const ATTR_LABEL: Record<string, string> = {
  force: '武力',
  leadership: '统帅',
  intelligent: '智力',
  politics: '政治',
};

/** 关系面板的视图筛选（面板每 250ms 重渲染，故筛选状态放在模块级而非 DOM） */
export const relView = {
  faction: 'all' as 'all' | Faction,
  met: 'all' as 'all' | 'met' | 'unmet',
  sort: 'favor' as 'favor' | 'faction',
};

const FACTIONS: Faction[] = ['蜀', '魏', '吴', '群'];

/**
 * 顶栏下方的「当前任务条」：全局最醒目的信息——此刻在做什么、还要多久。
 * 只改文本与进度宽度，不重建 DOM，避免打断 CSS 过渡。
 */
export function renderTaskbar(root: HTMLElement, state: GameState, cfg: GameConfig): void {
  const p = state.phase;
  let name = '待命';
  let target = '';
  let remain = 0;
  let total = 0;

  if (p.kind === 'moving' || p.kind === 'returning') {
    const slot = state.slots.find((s) => s.kind === 'task' && s.task.id === (p.kind === 'moving' ? p.taskId : null));
    if (p.kind === 'moving') {
      name = '赶路';
      const task = slot && slot.kind === 'task' ? slot.task : null;
      const def = task ? cfg.taskByTag[task.taskTag] : null;
      target = task ? `前往 ${cfg.cityByTag[task.cityTag]?.name ?? ''}·${def?.nodeName ?? ''} ${def?.name ?? ''}` : '';
    } else {
      name = '回城存仓';
      target = '背包已满，返回最近州府';
    }
    remain = p.remain;
    total = p.total;
  } else if (p.kind === 'working') {
    name = `作业 · ${p.label}`;
    const slot = state.slots.find((s) => s.kind === 'task' && s.task.id === p.taskId);
    const task = slot && slot.kind === 'task' ? slot.task : null;
    target = task ? `${cfg.cityByTag[task.cityTag]?.name ?? ''}` : '';
    remain = p.remain;
    total = p.total;
  } else {
    name = '待命';
    target = state.slots.some((s) => s.kind === 'task') ? '' : '等待任务补位';
  }

  const pct = total > 0 ? Math.max(0, Math.min(100, (1 - remain / total) * 100)) : 0;
  const nameEl = root.querySelector('.tb-name') as HTMLElement | null;
  const targetEl = root.querySelector('.tb-target') as HTMLElement | null;
  const remainEl = root.querySelector('.tb-remain') as HTMLElement | null;
  const barEl = root.querySelector('.bar.big > i') as HTMLElement | null;
  if (nameEl) nameEl.textContent = name;
  if (targetEl) targetEl.textContent = target;
  if (remainEl) {
    remainEl.textContent =
      total > 0
        ? `剩余 ${fmtDur(remain)}` + (state.phase.kind === 'moving' ? ` · ${Math.ceil(remain / cfg.values.speed)} 格` : '')
        : '—';
  }
  if (barEl) barEl.style.width = `${pct}%`;
}

/** 顶栏「指标胶囊」：把原本藏在弹窗里的关键状态提到一屏可见；背包将满时转警示色 */
export function renderTopStats(root: HTMLElement, state: GameState, cfg: GameConfig, speed: number): void {
  const cap = bagCapacity(cfg);
  const carried = bagItemCount(state);
  const ratio = cap > 0 ? carried / cap : 0;
  const metCount = GENERALS.filter((g) => (state.relations[g.tag] ?? 0) > 0).length;
  const topSkill = cfg.skillDefs.reduce((m, s) => Math.max(m, state.skills[s.tag]?.lv ?? 0), 0);

  const capsule = (label: string, value: string, cls = ''): string =>
    `<span class="cap ${cls}">${label}<b>${value}</b></span>`;

  const pending = state.pending.length;
  const pendingWarn = pending >= EVENT_CONTAINER_CAP - 5 ? 'warn' : '';
  root.innerHTML =
    capsule('任务', String(state.stats.tasksDone)) +
    `<span class="cap money" title="金钱（文）：工钱 + 赏金，用于缺料自动补货">金钱<b>${Math.floor(state.money)}</b></span>` +
    capsule('背包', `${carried}/${cap}`, ratio >= 0.8 ? 'warn' : '') +
    capsule('已结识', `${metCount}/${GENERALS.length}`) +
    capsule('技能', `Lv${topSkill}`) +
    `<button class="cap cap-btn ${pendingWarn}${pending ? ' has-ev' : ''}" data-open="event"` +
    ` title="打开事件列表">事件<b>${pending}</b></button>` +
    capsule('倍率', `×${speed}`);
}

export function renderBag(root: HTMLElement, state: GameState, cfg: GameConfig): void {
  const stack = Math.max(1, cfg.values.itemStacking);
  const used = bagSlotsUsed(state, cfg);
  const slots = cfg.values.backPackSlotNum;
  const cells: string[] = [];
  for (const [item, count] of Object.entries(state.bag)) {
    const groups = Math.ceil(count / stack);
    for (let g = 0; g < groups; g++) {
      const inStack = Math.min(stack, count - g * stack);
      const full = inStack >= stack;
      cells.push(`<div class="slot ${full ? 'full' : ''}">${itemName(item, cfg)}<br>${inStack}</div>`);
    }
  }
  while (cells.length < slots) cells.push('<div class="slot">空</div>');

  const store = Object.entries(state.storage);
  // 名品单独陈列（cat === '名品'），来自背包与仓库
  const mingqi = new Map<string, number>();
  for (const [k, v] of [...Object.entries(state.bag), ...Object.entries(state.storage)]) {
    if ((cfg.itemByTag[k]?.cat ?? '') === '名品') mingqi.set(k, (mingqi.get(k) ?? 0) + v);
  }
  const bpList = state.blueprints.map((t) => cfg.blueprintByTag[t]?.name ?? t);

  root.innerHTML =
    `<div class="kv"><span>背包</span><b>${bagItemCount(state)} / ${bagCapacity(cfg)} 件 · ${used}/${slots} 格</b></div>` +
    `<div class="bag-grid">${cells.join('')}</div>` +
    `<div class="kv"><span>仓库（全局共享）</span><b>${storageItemCount(state)} 件</b></div>` +
    (store.length
      ? store.map(([k, v]) => `<div class="kv"><span>${itemName(k, cfg)}</span><b>${v}</b></div>`).join('')
      : '<div class="kv"><span>暂无存货</span><b>—</b></div>') +
    `<h3 class="modal-sub">已习得图纸（${bpList.length}）</h3>` +
    (bpList.length ? bpList.map((n) => `<div class="kv"><span>${n}</span><b>✓</b></div>`).join('') : '<div class="sub">暂无</div>') +
    `<h3 class="modal-sub">名品收藏（${mingqi.size}）</h3>` +
    (mingqi.size
      ? [...mingqi.entries()].map(([k, v]) => `<div class="kv"><span class="r2">${itemName(k, cfg)}</span><b>${v}</b></div>`).join('')
      : '<div class="sub">暂无</div>');
}

export function renderAttrs(root: HTMLElement, state: GameState, cfg: GameConfig): void {
  root.innerHTML = ATTR_KEYS.map((k) => {
    const lv = state.attrs[k];
    const need = cfg.attrLvNeed(lv);
    const pct = need ? Math.min(100, (state.attrXp[k] / need) * 100) : 100;
    return (
      `<div class="attr">` +
      `<div class="attr-head"><span>${ATTR_NAMES[k]}</span><b>Lv ${lv}</b></div>` +
      `<div class="bar"><i style="width:${pct}%"></i></div>` +
      `<div class="sub">${need ? `${state.attrXp[k]} / ${need} 经验` : '已满级'}</div>` +
      `</div>`
    );
  }).join('');
}

export function renderCharacter(root: HTMLElement, state: GameState, cfg: GameConfig): void {
  const cityName = cfg.cityByTag[state.startCity]?.name ?? state.startCity;
  const items = Object.entries(state.stats.itemsGained);

  const AMBITION_LABELS: Record<string, string> = {
    free: '自由（纯随机）',
    wen: '文治 · 草药/炼丹/访道',
    wu: '武功 · 狩猎/锻造/结义',
    zong: '纵横 · 采矿/工造/使节',
    fang: '方外 · 草药/炼丹/结义',
  };
  const PACE_LABELS: Record<string, string> = { steady: '稳（品质偏低）', mid: '中（常态）', bold: '搏（品质偏高）' };
  const ambOpts = (Object.keys(AMBITION_LABELS) as string[])
    .map((k) => `<option value="${k}" ${state.ambition === k ? 'selected' : ''}>${AMBITION_LABELS[k]}</option>`)
    .join('');
  const paceOpts = (Object.keys(PACE_LABELS) as string[])
    .map((k) => `<option value="${k}" ${state.pace === k ? 'selected' : ''}>${PACE_LABELS[k]}</option>`)
    .join('');
  root.innerHTML =
    `<div class="kv"><span>出生城市</span><b>${cityName}</b></div>` +
    `<h3 class="modal-sub">志向与节奏</h3>` +
    `<div class="kv"><span>抱负</span><select id="ambition-select" class="rel-select">${ambOpts}</select></div>` +
    `<div class="kv"><span>节奏</span><select id="pace-select" class="rel-select">${paceOpts}</select></div>` +
    `<p class="tip">抱负决定任务偏向（约 2/3 落在偏好技能线）；节奏只平移品质窗口，不影响技能偏向。二者独立，可随时改。</p>` +
    renderClassSection(state, cfg) +
    `<h3 class="modal-sub">四维属性</h3>` +
    ATTR_KEYS.map((k) => {
      const lv = state.attrs[k];
      const need = cfg.attrLvNeed(lv);
      const pct = need ? Math.min(100, (state.attrXp[k] / need) * 100) : 100;
      return (
        `<div class="attr">` +
        `<div class="attr-head"><span>${ATTR_NAMES[k]}</span><b>Lv ${lv}</b></div>` +
        `<div class="bar"><i style="width:${pct}%"></i></div>` +
        `<div class="sub">${need ? `${state.attrXp[k]} / ${need} 经验` : '已满级'}</div>` +
        `</div>`
      );
    }).join('') +
    `<h3 class="modal-sub">技能（${cfg.skillDefs.length}）</h3>` +
    cfg.skillDefs
      .map((s) => {
        const sp = state.skills[s.tag] ?? { lv: 1, xp: 0 };
        const need = cfg.attrLvNeed(sp.lv);
        const pct = need ? Math.min(100, (sp.xp / need) * 100) : 100;
        return (
          `<div class="attr">` +
          `<div class="attr-head"><span>${s.name}</span><b>Lv ${sp.lv}</b></div>` +
          `<div class="bar"><i style="width:${pct}%"></i></div>` +
          `<div class="sub">${need ? `${sp.xp} / ${need} 经验 · ${s.nodeName}` : '已满级 · ' + s.nodeName}</div>` +
          `</div>`
        );
      })
      .join('') +
    `<h3 class="modal-sub">旅途统计</h3>` +
    `<div class="kv"><span>完成任务</span><b>${state.stats.tasksDone}</b></div>` +
    `<div class="kv"><span>回城存仓</span><b>${state.stats.returnTrips} 次</b></div>` +
    `<div class="kv"><span>累计行走</span><b>${state.stats.cellsWalked} 格</b></div>` +
    `<div class="kv"><span>累计产出</span><b>${
      items.length ? items.map(([k, v]) => `${itemName(k, cfg)} ${v}`).join(' · ') : '—'
    }</b></div>`;
}

/** 职业 / 身份面板段（V6）。每 250ms 重渲染，故选择器挂在持久节点上的事件委托里。 */
function renderClassSection(state: GameState, cfg: GameConfig): string {
  const unlocked = getUnlockedClasses(state, cfg);
  const unlockedSet = new Set(unlocked.map((c) => c.classType));
  const unlockedNow = isClassUnlocked(state, cfg);
  const slots = activeStandingSlots(state, cfg);

  const classRows = cfg.classDefs
    .map((c) => {
      const isU = unlockedSet.has(c.classType);
      const aff = cfg.classAffinityMap[c.classType] ?? {};
      const affNames = Object.entries(aff)
        .map(([sk, lv]) => `${cfg.skillByTag[sk]?.name ?? sk}${lv === 'main' ? '★' : '◐'}`)
        .join(' ');
      if (!isU) {
        const cond = (c.promoteCond ?? '')
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((id) => condText(cfg, id))
          .join('，');
        return `<div class="kv lock"><span>${c.name}</span><b class="sub">🔒 ${cond || '未配置'}</b></div>`;
      }
      const p = classProgress(state, cfg, c.classType);
      const pct = p.need ? Math.min(100, (p.exp / p.need) * 100) : 100;
      const active = state.activeClass === c.classType ? ' · <b>生效中</b>' : '';
      return (
        `<div class="kv"><span>${c.name}${active}</span><b>第 ${p.rank} 阶</b></div>` +
        `<div class="bar"><i style="width:${pct}%"></i></div>` +
        `<div class="sub">${p.need ? `${p.exp} / ${p.need} 经验` : '满阶'} · 亲密度 ${affNames || '—'}</div>`
      );
    })
    .join('');

  const activeOpts = unlocked.length
    ? `<select id="class-select" class="rel-select">` +
      `<option value="">（不选）</option>` +
      unlocked
        .map((c) => `<option value="${c.classType}" ${state.activeClass === c.classType ? 'selected' : ''}>${c.name}</option>`)
        .join('') +
      `</select>`
    : '<span class="sub">暂无可晋身职业</span>';

  const cd =
    state.classSwitchCd && Date.now() < state.classSwitchCd
      ? ` · 冷却 ${Math.ceil((state.classSwitchCd - Date.now()) / 1000)}s`
      : '';

  const standingRows = cfg.standingDefs.length
    ? cfg.standingDefs
        .map((s) => {
          const met = standingReqMet(state, s);
          const on = state.standingActive.includes(s.standingTag);
          const req = standingReqText(cfg, s);
          return `<div class="kv"><span>${s.name}</span><b class="${met ? 'ok' : 'sub'}">${on ? '✓ 已上阵' : met ? '可上阵' : '🔒 ' + req}</b></div>`;
        })
        .join('')
    : '<div class="sub">暂无身份</div>';

  const sysLine = unlockedNow
    ? `已解锁（总技能 Lv ${totalSkillLv(state)}）`
    : `未解锁 · 总技能 Lv ${totalSkillLv(state)} / ${cfg.values.classUnlockSkillLvTotal}`;

  return (
    `<h3 class="modal-sub">职业（V6）</h3>` +
    `<div class="kv"><span>职业系统</span><b>${sysLine}</b></div>` +
    classRows +
    `<div class="kv"><span>生效职业</span>${activeOpts}${cd}</div>` +
    `<p class="tip">职业解锁后，任务偏向由「生效职业的亲密度技能」决定（取代抱负）。切换有冷却。职业经验只由亲密度技能任务积累，阶数越高效果越强（粗颗粒，非平滑）。</p>` +
    `<h3 class="modal-sub">身份（上阵位 ${slots}）</h3>` +
    standingRows +
    `<p class="tip">身份由职业组合晋阶解锁，不可降级；上阵交互待后续。</p>`
  );
}

/** 晋身条件 → 人话 */
function condText(cfg: GameConfig, id: string): string {
  const c = cfg.classPromoteCondByTag[id];
  if (!c) return id;
  switch (c.type) {
    case 'a_rep':
      return `${cfg.skillByTag[c.target]?.name ?? c.target} 达 Lv${c.threshold}`;
    case 'b_general':
      return `${c.target === 'any' ? '任一武将' : GENERALS.find((g) => g.tag === c.target)?.name ?? c.target} 好感 ≥ ${c.threshold}`;
    case 'c_standing':
      return `获得身份「${cfg.standingByTag[c.target]?.name ?? c.target}」`;
    case 'd_train':
      return c.target === 'totalSkillLv'
        ? `总技能等级 ≥ ${c.threshold}`
        : `${ATTR_NAMES[c.target as AttrKey] ?? c.target} ≥ ${c.threshold}`;
    default:
      return id;
  }
}

/** 身份需求 → 人话 */
function standingReqText(cfg: GameConfig, s: StandingDef): string {
  const cls = (s.reqClasses || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const [ct, lv] = pair.split(':');
      return `${cfg.classByTag[ct]?.name ?? ct} ${lv}阶`;
    })
    .join(' + ');
  const st = (s.reqStandings || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((t) => `身份「${cfg.standingByTag[t]?.name ?? t}」`)
    .join(' + ');
  return [cls, st].filter(Boolean).join(' + ') || '无要求';
}

export function renderRelations(root: HTMLElement, state: GameState, _cfg: GameConfig): void {
  const target = state.target;
  const metCount = GENERALS.filter((g) => (state.relations[g.tag] ?? 0) > 0).length;

  const options =
    `<option value="">— 未选定 —</option>` +
    GENERALS.map((g) => `<option value="${g.tag}" ${target === g.tag ? 'selected' : ''}>${g.name}（${g.faction}）</option>`).join('');

  const relOf = (tag: string): number => state.relations[tag] ?? 0;
  let list = GENERALS.filter((g) => {
    if (relView.faction !== 'all' && g.faction !== relView.faction) return false;
    const v = relOf(g.tag);
    if (relView.met === 'met' && v <= 0) return false;
    if (relView.met === 'unmet' && v > 0) return false;
    return true;
  });
  if (relView.sort === 'favor') list = [...list].sort((a, b) => relOf(b.tag) - relOf(a.tag));
  else list = [...list].sort((a, b) => FACTIONS.indexOf(a.faction) - FACTIONS.indexOf(b.faction) || relOf(b.tag) - relOf(a.tag));

  const cards = list.map((g) => {
    const v = state.relations[g.tag] ?? 0;
    const st = relationStage(v);
    const pct = Math.round(st.progress * 100);
    const isTarget = target === g.tag;
    const prefMain = ATTR_LABEL[g.mainPref];
    const prefSub = ATTR_LABEL[g.subPref];
    const nextText =
      v <= 0
        ? '尚未结识 · 多接「人物」类任务可偶遇'
        : st.nextMin === Infinity
          ? '已达最高'
          : `距「${REL_STAGES[st.index + 1].name}」还需 ${Math.ceil(st.nextMin - v)}`;
    const btn = isTarget
      ? `<button class="mini active" data-rel-target="">取消攻略</button>`
      : `<button class="mini" data-rel-target="${g.tag}">设为攻略</button>`;
    return (
      `<div class="rel-card ${isTarget ? 'is-target' : ''}">` +
      `<div class="rel-top">` +
      `<span class="fac ${FACTION_CLS[g.faction]}">${g.faction}</span>` +
      `<span class="rel-name">${g.name}</span>` +
      `<span class="rel-stage">${st.name}</span>` +
      `</div>` +
      `<div class="rel-pref">主 ${prefMain} · 次 ${prefSub}</div>` +
      `<div class="bar"><i style="width:${pct}%"></i></div>` +
      `<div class="sub">好感 ${v.toFixed(1)} · ${nextText}</div>` +
      `<div class="rel-act">${btn}</div>` +
      `</div>`
    );
  }).join('');

  const chip = (active: boolean, attrs: string, text: string): string =>
    `<button class="mini ${active ? 'active' : ''}" ${attrs}>${text}</button>`;
  const factionChips =
    chip(relView.faction === 'all', 'data-rel-faction="all"', '全部') +
    FACTIONS.map((f) => chip(relView.faction === f, `data-rel-faction="${f}"`, f)).join('');
  const metChips =
    chip(relView.met === 'all', 'data-rel-met="all"', '全部') +
    chip(relView.met === 'met', 'data-rel-met="met"', '已结识') +
    chip(relView.met === 'unmet', 'data-rel-met="unmet"', '未结识');
  const sortChip = chip(
    true,
    `data-rel-sort="${relView.sort === 'favor' ? 'faction' : 'favor'}"`,
    relView.sort === 'favor' ? '按好感↓' : '按阵营',
  );

  root.innerHTML =
    `<div class="rel-head">` +
    `<div class="kv"><span>攻略对象</span>` +
    `<select id="rel-target" class="rel-select">${options}</select></div>` +
    `<p class="tip">攻略对象的好感获取 ×2；完成任务按属性"事迹传播"——武力/统帅/智力/政治各有所好，已结识 ${metCount} / ${GENERALS.length} 人。</p>` +
    `</div>` +
    `<div class="rel-filter">` +
    `<div class="ctrl-row">${factionChips}</div>` +
    `<div class="ctrl-row">${metChips}${sortChip}</div>` +
    `</div>` +
    `<div class="rel-list">${cards || '<div class="sub">当前筛选下没有武将</div>'}</div>`;
}

/**
 * 随机事件面板：待处理事件容器（≤10，统一 4h）+ 交互（none/binary/multi，无小游戏）。
 * 选择后**直接结算**；底部附只读的见闻收集清单（最小形态，不做图鉴）。
 */
/**
 * 奖励飘字：稀有 / 传说事件专属，用于放大"惊喜"。
 * 只做短促的一次性强化，不作为主要反馈（主要反馈是面板内的结果卡）。
 */
export function floatReward(lines: RewardLine[], rarity: number): void {
  const wrap = document.getElementById('float-wrap');
  if (!wrap || !lines.length) return;
  // 连点时关掉旧飘字，避免堆叠
  wrap.querySelectorAll('.float-reward').forEach((n) => {
    const node = n as HTMLElement;
    node.classList.add('out');
    window.setTimeout(() => node.remove(), 220);
  });
  const el = document.createElement('div');
  el.className = `float-reward r${rarity}`;
  el.innerHTML = lines.map((l) => `<div>${esc(l.text)}</div>`).join('');
  wrap.appendChild(el);
  window.setTimeout(() => el.classList.add('out'), 1300);
  window.setTimeout(() => el.remove(), 2100);
}


/** 经验条增长动画：从 before% 过渡到 after%；若跨级则先冲满、再升一级从 0 起跳 */
function animateAttrBar(scope: HTMLElement, cfg: GameConfig, g: AttrGainInfo): void {
  const fill = scope.querySelector('.ev-attr-fill') as HTMLElement | null;
  if (!fill) return;
  const beforeNeed = cfg.attrLvNeed(g.beforeLv);
  const afterNeed = cfg.attrLvNeed(g.afterLv);
  const beforePct = beforeNeed ? Math.min(100, (g.beforeXp / beforeNeed) * 100) : 100;
  const afterPct = afterNeed ? Math.min(100, (g.afterXp / afterNeed) * 100) : 100;
  fill.style.width = `${beforePct}%`;
  if (g.afterLv > g.beforeLv) {
    // 跨级：先冲到满，再升一级从 0 增长到 after
    requestAnimationFrame(() => {
      fill.style.transition = 'width .45s ease-out';
      fill.style.width = '100%';
    });
    window.setTimeout(() => {
      const lvEl = scope.querySelector('.ev-attr-lv') as HTMLElement | null;
      if (lvEl) lvEl.textContent = `Lv ${g.afterLv}`;
      fill.style.transition = 'none';
      fill.style.width = '0%';
      requestAnimationFrame(() => {
        fill.style.transition = 'width .5s ease-out';
        fill.style.width = `${afterPct}%`;
      });
    }, 470);
  } else {
    requestAnimationFrame(() => {
      fill.style.transition = 'width .7s ease-out';
      fill.style.width = `${afterPct}%`;
    });
  }
}

/** 技能经验条增长动画：与属性经验条同构，复用同一条升级曲线（cfg.attrLvNeed） */
function animateSkillBar(scope: HTMLElement, cfg: GameConfig, g: SkillGainInfo): void {
  const fill = scope.querySelector('.ev-skill-fill') as HTMLElement | null;
  if (!fill) return;
  const beforeNeed = cfg.attrLvNeed(g.beforeLv);
  const afterNeed = cfg.attrLvNeed(g.afterLv);
  const beforePct = beforeNeed ? Math.min(100, (g.beforeXp / beforeNeed) * 100) : 100;
  const afterPct = afterNeed ? Math.min(100, (g.afterXp / afterNeed) * 100) : 100;
  fill.style.width = `${beforePct}%`;
  if (g.afterLv > g.beforeLv) {
    requestAnimationFrame(() => {
      fill.style.transition = 'width .45s ease-out';
      fill.style.width = '100%';
    });
    window.setTimeout(() => {
      const lvEl = scope.querySelector('.ev-skill-lv') as HTMLElement | null;
      if (lvEl) lvEl.textContent = `Lv ${g.afterLv}`;
      fill.style.transition = 'none';
      fill.style.width = '0%';
      requestAnimationFrame(() => {
        fill.style.transition = 'width .5s ease-out';
        fill.style.width = `${afterPct}%`;
      });
    }, 470);
  } else {
    requestAnimationFrame(() => {
      fill.style.transition = 'width .7s ease-out';
      fill.style.width = `${afterPct}%`;
    });
  }
}

/**
 * 结算结果卡（独立于列表、跨 250ms 重渲染保留）。
 * 奖励行下方若有属性经验变化，追加该属性的经验条并播放增长动画。
 * 同一结果（at 相同）直接保留不重建 → 经验条动画只播一次，2.6s 后 result 变 null 时移除。
 */
function renderResultCard(
  slot: HTMLElement,
  result: EventResult | null | undefined,
  cfg: GameConfig,
): void {
  if (!result) {
    if (slot.firstChild) slot.innerHTML = '';
    return;
  }
  // 同一结果已渲染 → 保留（不重建），让经验条动画完整播放
  const cur = slot.querySelector('.ev-result');
  if (cur && cur.getAttribute('data-at') === String(result.at)) return;

  const g = result.attrGain;
  const sg = result.skillGain;
  let attrHtml = '';
  if (g) {
    attrHtml =
      `<div class="ev-attr">` +
      `<div class="ev-attr-head"><span>${ATTR_NAMES[g.key]}经验</span>` +
      `<b class="ev-attr-lv">Lv ${g.afterLv}</b></div>` +
      `<div class="ev-attr-bar"><i class="ev-attr-fill"></i></div>` +
      `</div>`;
  }
  let skillHtml = '';
  if (sg) {
    skillHtml =
      `<div class="ev-attr ev-skill">` +
      `<div class="ev-attr-head"><span>${sg.name}经验</span>` +
      `<b class="ev-skill-lv">Lv ${sg.afterLv}</b></div>` +
      `<div class="ev-attr-bar"><i class="ev-skill-fill"></i></div>` +
      `</div>`;
  }

  slot.innerHTML =
    `<div class="ev-result r${result.rarity}" data-at="${result.at}">` +
    `<div class="ev-result-top">已处理 · ${esc(result.title)}` +
    `${result.optionText ? `　你选择了「${esc(result.optionText)}」` : ''}</div>` +
    `<div class="ev-result-lines">` +
    result.lines
      .map((l) => `<div><span class="ri">${l.icon}</span>${esc(l.text)}</div>`)
      .join('') +
    `</div>` +
    attrHtml +
    skillHtml +
    `</div>`;

  // 播放经验条增长动画（属性 / 技能各播一次；连点新结果替换整卡重播）
  if (g) animateAttrBar(slot, cfg, g);
  if (sg) animateSkillBar(slot, cfg, sg);
}

export function renderEvents(
  root: HTMLElement,
  state: GameState,
  cfg: GameConfig,
  result?: EventResult | null,
): void {
  const now = Date.now();

  // 惰性初始化持久结构：结果卡槽 + 列表容器。
  // 列表每 250ms 照常重渲染；结果卡写入独立的槽并跨重渲染保留（不重建），
  // 这样属性经验条增长动画能完整播放一次，不会被 250ms 重建反复重播。
  let resultSlot = root.querySelector<HTMLElement>('#ev-result-slot');
  let listRoot = root.querySelector<HTMLElement>('#ev-list');
  if (!resultSlot || !listRoot) {
    root.innerHTML = `<div id="ev-result-slot"></div><div id="ev-list"></div>`;
    resultSlot = root.querySelector<HTMLElement>('#ev-result-slot')!;
    listRoot = root.querySelector<HTMLElement>('#ev-list')!;
  }

  // 结果卡：仅在新结果（at 变化）时替换；同一结果跨重渲染保留 → 经验条动画只播一次
  renderResultCard(resultSlot, result, cfg);


  // 最紧急的排在最前（剩余时间升序）
  const list = [...state.pending].sort((a, b) => a.expireAt - b.expireAt);

  const cards = list
    .map((pe) => {
      const def = eventByTag[pe.tag];
      if (!def) return '';
      const span = Math.max(1, pe.expireAt - pe.at);
      const left = Math.max(0, pe.expireAt - now);
      const pct = Math.max(0, Math.min(100, (left / span) * 100));
      const urgent = left <= 1800; // ≤30 分钟转紧急
      const leftText = left >= 3600 ? `${Math.floor(left / 3600000)} 小时余` : `${Math.max(0, Math.ceil(left / 60000))} 分`;
      const text = def.text.replace(/\{city\}/g, pe.cityName || '此地');

      // 选项奖励预告：让玩家在选择前看到各选项的收益差异
      const optBtn = (i: number, label: string, hint: string): string =>
        `<button class="ev-opt" data-ev-act="${pe.id}" data-ev-opt="${i}">` +
        `<span class="ev-opt-idx">${i + 1}</span>` +
        `<span class="ev-opt-body">` +
        `<span class="ev-opt-text">${esc(label)}</span>` +
        (hint ? `<span class="ev-opt-hint">${esc(hint)}</span>` : '') +
        `</span></button>`;

      const opts = def.options?.length
        ? def.options.map((o, i) => optBtn(i, o.text, describeOptionRewards(cfg, o))).join('')
        : optBtn(0, '记下此事', describeOptionRewards(cfg, def));

      return (
        `<div class="ev-card ev-r${def.rarity}${urgent ? ' urgent' : ''}">` +
        `<div class="ev-card-top">` +
        `<span class="ev-type">${EVENT_TYPE_NAMES[def.type]}</span>` +
        `<span class="ev-title">${esc(def.title)}</span>` +
        `<span class="ev-ttl${urgent ? ' urgent' : ''}">${leftText}</span>` +
        `</div>` +
        `<div class="ev-ttl-bar"><i style="width:${pct}%"></i></div>` +
        `<div class="ev-text-full">${esc(text)}</div>` +
        `<div class="ev-act">${opts}</div>` +
        `</div>`
      );
    })
    .join('');

  const capPct = Math.min(100, (state.pending.length / EVENT_CONTAINER_CAP) * 100);
  const jw = state.jianwen.map((t) => `<span class="jw-chip">${JIANWEN_NAMES[t] ?? t}</span>`).join('');
  const jwTotal = Object.keys(JIANWEN_NAMES).length;

  listRoot.innerHTML =
    `<div class="ev-summary">` +
    `<div class="kv"><span>待处理</span><b>${state.pending.length} / ${EVENT_CONTAINER_CAP}</b></div>` +
    `<div class="bar"><i style="width:${capPct}%"></i></div>` +
    `<div class="kv"><span>今日已出现</span><b>${state.eventToday} / ${EVENT_DAILY_CAP}</b></div>` +
    `<p class="tip">每条限时 4 小时，超时一般只失去这次机会（不倒扣任何所得）；但最近的 ${EVENT_KEEP_MIN} 条会保底保留，离线再久也至少能看到/处理 ${EVENT_KEEP_MIN} 条 · 在线时每 10 分钟、到达新城市、首次造访设施或完成高品质任务都会带来新事件</p>` +
    `</div>` +
    (cards ||
      `<div class="ev-empty-box">` +
      `<div class="sub">暂无待处理事件</div>` +
      `<p class="tip">继续赶路与做任务，或造访新的城市与设施，就会有事件发生。</p>` +
      `</div>`) +
    `<details class="ev-jw"><summary>见闻 ${state.jianwen.length} / ${jwTotal}</summary>` +
    `<div class="jw-list">${jw || '<div class="sub">尚未有所见闻</div>'}</div>` +
    `</details>`;
}

export interface ControlHandlers {
  speed: number;
  onSpeed: (v: number) => void;
  onSave: () => void;
  onReset: () => void;
  lastSavedAt: number;
  isActive: boolean;
}

export function renderControls(root: HTMLElement, h: ControlHandlers): void {
  const speeds = [1, 10, 60];
  root.innerHTML =
    `<div class="ctrl-row"><span class="ctrl-label">时间加速</span>` +
    speeds.map((v) => `<button class="mini ${h.speed === v ? 'active' : ''}" data-speed="${v}">×${v}</button>`).join('') +
    `</div>` +
    `<div class="ctrl-row"><button class="mini" id="btn-save">立即存档</button>` +
    `<button class="mini" id="btn-reset">重置存档</button></div>` +
    `<div class="kv"><span>上次存档</span><b>${h.lastSavedAt ? fmtClock(h.lastSavedAt) : '—'}</b></div>` +
    `<div class="kv"><span>本标签页</span><b>${h.isActive ? '推进中（主）' : '只读（已在别处打开）'}</b></div>`;

  root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
    b.onclick = () => h.onSpeed(Number(b.dataset.speed));
  });
  const saveBtn = root.querySelector<HTMLButtonElement>('#btn-save');
  if (saveBtn) saveBtn.onclick = h.onSave;
  const resetBtn = root.querySelector<HTMLButtonElement>('#btn-reset');
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (confirm('确定重置存档？当前进度会被清空并重新出生。')) h.onReset();
    };
  }
}

export function renderCheck(root: HTMLElement, result: CheckResult, warnings: string[], cfg: GameConfig): void {
  const items = result.items
    .map(
      (it) =>
        `<div class="check-item ${it.ok ? 'ok' : 'bad'}"><span>${it.label}</span>` +
        `<span>${it.actual === it.expect ? '✓ ' + it.actual : it.actual + '（应 ' + it.expect + '）'}</span></div>`,
    )
    .join('');
  const s = result.stats;
  root.innerHTML =
    items +
    `<div class="kv" style="margin-top:6px"><span>图规模</span><b>${s.nodeCount} 点 ${s.edgeCount} 边</b></div>` +
    `<div class="kv"><span>平均路程</span><b>${s.avgAll.toFixed(2)} 格（最大 ${s.maxDist}）</b></div>` +
    `<div class="kv"><span>配置</span><b>${cfg.meta.file} · V${cfg.meta.version}</b></div>` +
    (warnings.length ? `<div class="warn">${warnings.join('<br>')}</div>` : '');
}

/** 已渲染过的事件 seq（增量渲染用，保证淡入动画每条只播一次） */
let feedSeen = new Set<number>();
let feedInit = false;

function evRow(e: GameEvent, fresh: boolean): string {
  return (
    `<div class="ev ev-r${e.rarity}${fresh ? ' fresh' : ''}" data-seq="${e.seq}">` +
    `<span class="ev-time">${fmtClock(e.at)}</span>` +
    `<span class="ev-text">${esc(e.text)}</span>` +
    `</div>`
  );
}

/**
 * 事件流：取代普通日志成为主界面信息出口；按稀有度三档着色，新事件淡入。
 * 采用**增量渲染**（只在顶部插入新事件），避免 250ms 重建导致的动画反复重启。
 */
export function renderFeed(root: HTMLElement, state: GameState): void {
  const events = Array.isArray(state.events) ? state.events : [];
  const items = [...events].reverse().slice(0, 20); // 最新在上
  const want = new Set(items.map((e) => e.seq));

  // 首次渲染：全量铺开，且不带动画（否则开局满屏一起闪）
  if (!feedInit) {
    root.innerHTML = items.length
      ? items.map((e) => evRow(e, false)).join('')
      : '<div class="ev-empty">暂无记录</div>';
    feedSeen = new Set(items.map((e) => e.seq));
    feedInit = true;
    return;
  }

  // 无记录：稳定显示「暂无记录」占位，避免每帧重建导致闪烁。
  // 仅当占位缺失时才重建（如重置存档后残留旧节点），已显示则不触碰。
  if (items.length === 0) {
    if (!root.querySelector('.ev-empty')) {
      root.innerHTML = '<div class="ev-empty">暂无记录</div>';
      feedSeen.clear();
    }
    return;
  }

  // 有记录：确保占位已清除
  const empty = root.querySelector('.ev-empty');
  if (empty) empty.remove();

  // 被挤出事件流（超过 EVENT_LIMIT）的旧节点移除
  for (const node of Array.from(root.children)) {
    const seq = Number((node as HTMLElement).dataset.seq);
    if (Number.isFinite(seq) && !want.has(seq)) {
      feedSeen.delete(seq);
      node.remove();
    }
  }

  // 新事件：按 seq 升序插入顶部，最终最新在最上；只有它们带 fresh 动画
  const fresh = items.filter((e) => !feedSeen.has(e.seq)).sort((a, b) => a.seq - b.seq);
  for (const e of fresh) {
    const tpl = document.createElement('div');
    tpl.innerHTML = evRow(e, true);
    const node = tpl.firstElementChild;
    if (!node) continue;
    root.insertBefore(node, root.firstChild);
    feedSeen.add(e.seq);
  }
  while (root.children.length > 20) root.lastElementChild?.remove();
}

export function toast(msg: string, ms = 4200): void {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}
