import { ATTR_KEYS, ATTR_NAMES, type GameConfig, type GameState } from '../game/types';
import { bagCapacity, bagItemCount, bagSlotsUsed, storageItemCount } from '../game/state';
import type { CheckResult } from '../game/selfcheck';
import { fmtClock, fmtDur, itemName } from './format';

export function renderStatus(root: HTMLElement, state: GameState, cfg: GameConfig): void {
  const p = state.phase;
  let name = '待命';
  let target = '';
  let remain = 0;
  let total = 0;
  let cls = 'bar';

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
      cls = 'bar green';
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
    cls = 'bar blue';
  } else {
    name = '待命';
    target = state.slots.some((s) => s.kind === 'task') ? '' : '等待任务补位';
  }

  const pct = total > 0 ? Math.max(0, Math.min(100, (1 - remain / total) * 100)) : 0;
  root.innerHTML =
    `<div class="phase-row"><span class="phase-name">${name}</span>` +
    `<span class="phase-target">${target}</span></div>` +
    `<div class="${cls}"><i style="width:${pct}%"></i></div>` +
    `<div class="sub">${total > 0 ? `剩余 ${fmtDur(remain)} / 共 ${fmtDur(total)}` : '—'}` +
    `${state.phase.kind === 'moving' ? ` · ${Math.ceil(remain / cfg.values.speed)} 格` : ''}</div>`;
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
      cells.push(`<div class="slot ${full ? 'full' : ''}">${itemName(item)}<br>${inStack}</div>`);
    }
  }
  while (cells.length < slots) cells.push('<div class="slot">空</div>');

  const store = Object.entries(state.storage);
  root.innerHTML =
    `<div class="kv"><span>背包</span><b>${bagItemCount(state)} / ${bagCapacity(cfg)} 件 · ${used}/${slots} 格</b></div>` +
    `<div class="bag-grid">${cells.join('')}</div>` +
    `<div class="kv"><span>仓库（全局共享）</span><b>${storageItemCount(state)} 件</b></div>` +
    (store.length
      ? store.map(([k, v]) => `<div class="kv"><span>${itemName(k)}</span><b>${v}</b></div>`).join('')
      : '<div class="kv"><span>暂无存货</span><b>—</b></div>');
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
  root.innerHTML =
    `<div class="kv"><span>出生城市</span><b>${cityName}</b></div>` +
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
    `<h3 class="modal-sub">旅途统计</h3>` +
    `<div class="kv"><span>完成任务</span><b>${state.stats.tasksDone}</b></div>` +
    `<div class="kv"><span>回城存仓</span><b>${state.stats.returnTrips} 次</b></div>` +
    `<div class="kv"><span>累计行走</span><b>${state.stats.cellsWalked} 格</b></div>` +
    `<div class="kv"><span>累计产出</span><b>${
      items.length ? items.map(([k, v]) => `${itemName(k)} ${v}`).join(' · ') : '—'
    }</b></div>`;
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

export function renderLog(root: HTMLElement, state: GameState): void {
  root.innerHTML = state.log.length
    ? state.log
        .slice(0, 12)
        .map((l) => `<div>${fmtClock(l.at)} ${l.text}</div>`)
        .join('')
    : '<div>暂无记录</div>';
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
