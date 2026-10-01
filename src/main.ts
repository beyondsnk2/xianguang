import { loadGameConfig } from './config/loader';
import { buildGraph, type Graph } from './game/graph';
import { buildTaskIndex, type TaskIndex } from './game/taskGen';
import { createInitialState, normalizeSlots, pushLog, storageItemCount } from './game/state';
import { syncPhase, tick, type TickCtx } from './game/tick';
import { loadState, saveState, clearSave, TabLeader } from './game/save';
import { runSelfCheck } from './game/selfcheck';
import { OFFLINE_CAP_HOURS } from './game/constants';
import type { GameConfig, GameState } from './game/types';
import { MapRenderer } from './render/map';
import { autoSort, TaskBoard } from './ui/taskList';
import {
  renderBag,
  renderCharacter,
  renderCheck,
  renderControls,
  renderLog,
  renderStatus,
  toast,
} from './ui/panels';
import { fmtDur } from './ui/format';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
};

async function boot(): Promise<void> {
  const bootText = el('boot-text');
  let cfg: GameConfig;
  let warnings: string[];
  try {
    bootText.textContent = '正在读取 config/ 下的配置…';
    const loaded = await loadGameConfig();
    cfg = loaded.config;
    warnings = loaded.warnings;
  } catch (e) {
    bootText.innerHTML = `配置读取失败：${(e as Error).message}<br><br>请确认已执行 <b>npm run dev</b>（而非直接打开 html）。`;
    return;
  }

  bootText.textContent = '正在构建路网…';
  const graph: Graph = buildGraph(cfg);
  const taskIndex: TaskIndex = buildTaskIndex(cfg);
  const ctx: TickCtx = { cfg, graph, taskIndex };

  let state: GameState = loadState() ?? createInitialState(cfg, Date.now());
  // 配置槽位数变化时的最小迁移
  if (state.slots.length !== cfg.values.initTaskListSlot) {
    while (state.slots.length > cfg.values.initTaskListSlot) state.slots.pop();
    while (state.slots.length < cfg.values.initTaskListSlot) state.slots.push({ kind: 'empty', refillIn: 0 });
  }
  if (!state.log) state.log = [];
  normalizeSlots(state); // 老存档可能把空槽留在列表中段，读档时归位到队尾

  // ── 离线结算：本地时间戳 + 离散事件推进 + 上限 8 小时 ──
  const now = Date.now();
  let elapsed = (now - state.lastTickAt) / 1000;
  if (elapsed < 0) elapsed = 0; // 系统时间被改小，直接丢弃
  const capped = Math.min(elapsed, OFFLINE_CAP_HOURS * 3600);
  if (capped > 5) {
    const before = {
      tasks: state.stats.tasksDone,
      returns: state.stats.returnTrips,
      storage: storageItemCount(state),
    };
    tick(state, capped, ctx);
    const gained = storageItemCount(state) - before.storage;
    pushLog(state, `离线结算 ${fmtDur(capped)}：完成 ${state.stats.tasksDone - before.tasks} 个任务`);
    toast(
      `你离开了 ${fmtDur(elapsed)}${elapsed > capped ? `（离线收益上限 ${OFFLINE_CAP_HOURS} 小时，结算 ${fmtDur(capped)}）` : ''}：` +
        `完成 ${state.stats.tasksDone - before.tasks} 个任务，回城 ${state.stats.returnTrips - before.returns} 次，入仓 ${gained} 件`,
      8000,
    );
  }
  state.lastTickAt = Date.now();
  syncPhase(state, ctx);

  // ── 界面装配 ──
  const renderer = new MapRenderer(el<HTMLCanvasElement>('map'));
  renderer.fit();

  const board = new TaskBoard(el('task-board'), {
    onReorder: (from, to) => {
      if (from === to) return;
      const item = state.slots[from];
      if (!item || item.kind !== 'task') return;
      if (item.task.id === state.currentTaskId) return; // 队首锁定
      state.slots.splice(from, 1);
      state.slots.splice(to, 0, item);
      normalizeSlots(state); // 空槽始终留在队尾
      syncPhase(state, ctx);
      refreshUI();
    },
  });

  el('meta-line').textContent =
    `${cfg.meta.setName} V${cfg.meta.version} · ${cfg.meta.file} · 生效表 ${cfg.meta.sheets.length} 张 · ` +
    `${cfg.nodes.length} 节点 / ${cfg.roads.length} 道路格`;

  const checkResult = runSelfCheck(cfg, graph);
  renderCheck(el('check-body'), checkResult, warnings, cfg);
  if (!checkResult.ok) toast('路网自检存在偏差，请查看「配置与路网自检」', 8000);
  if (warnings.length) toast(`配置有 ${warnings.length} 条校验告警`, 6000);

  // ── 多标签抢占 ──
  const leader = new TabLeader();
  leader.onChange = () => refreshControls();
  leader.start();
  window.addEventListener('pagehide', () => leader.stop());

  let speed = 1;
  let lastSavedAt = 0;

  function refreshControls(): void {
    renderControls(el('ctrl-body'), {
      speed,
      onSpeed: (v) => {
        speed = v;
        refreshControls();
      },
      onSave: () => {
        saveState(state);
        lastSavedAt = Date.now();
        refreshControls();
        toast('已存档');
      },
      onReset: () => {
        clearSave();
        state = createInitialState(cfg, Date.now());
        syncPhase(state, ctx);
        saveState(state);
        refreshUI();
        toast('已重置存档，重新出生');
      },
      lastSavedAt,
      isActive: leader.active,
    });
  }

  // ── 左侧菜单弹窗：背包 / 角色 ──
  let openModalKind: 'bag' | 'char' | null = null;
  function renderModal(): void {
    if (!openModalKind) return;
    if (openModalKind === 'bag') renderBag(el('modal-body'), state, cfg);
    else renderCharacter(el('modal-body'), state, cfg);
  }
  function openModal(kind: 'bag' | 'char'): void {
    openModalKind = kind;
    el('modal-title').textContent = kind === 'bag' ? '背包 / 仓库' : '角色信息';
    (el('modal-wrap') as HTMLElement).hidden = false;
    renderModal();
  }
  function closeModal(): void {
    openModalKind = null;
    (el('modal-wrap') as HTMLElement).hidden = true;
  }
  el('menu-bag').addEventListener('click', () => openModal('bag'));
  el('menu-char').addEventListener('click', () => openModal('char'));
  el('modal-close').addEventListener('click', closeModal);
  el('modal-wrap').addEventListener('click', (ev) => {
    if (ev.target === el('modal-wrap')) closeModal(); // 点遮罩关闭
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeModal();
  });

  function refreshUI(): void {
    renderStatus(el('status-body'), state, cfg);
    renderModal();
    renderLog(el('log-body'), state);
    board.update(state, cfg, graph);
    el('stat-tasks').textContent = String(state.stats.tasksDone);
    el('stat-returns').textContent = String(state.stats.returnTrips);
    el('stat-cells').textContent = String(state.stats.cellsWalked);
    el('stat-speed').textContent = String(cfg.values.speed);
  }

  el('btn-autosort').addEventListener('click', () => {
    autoSort(state, cfg, graph);
    normalizeSlots(state);
    syncPhase(state, ctx);
    refreshUI();
    toast('已按最近邻重排（队首不动）');
  });
  el('btn-fit').addEventListener('click', () => renderer.fit());
  el('btn-zoomin').addEventListener('click', () => renderer.zoom(1.25));
  el('btn-zoomout').addEventListener('click', () => renderer.zoom(0.8));

  // 地图交互：滚轮缩放 / 拖动平移
  const canvas = el<HTMLCanvasElement>('map');
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoom(ev.deltaY < 0 ? 1.12 : 0.89, ev.clientX - rect.left, ev.clientY - rect.top);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    renderer.pan(ev.clientX - lastX, ev.clientY - lastY);
    lastX = ev.clientX;
    lastY = ev.clientY;
  });
  const endDrag = () => {
    dragging = false;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas.parentElement as HTMLElement);

  // ── 主循环：位置 = f(绝对时间戳)，绝不帧累加 ──
  function frame(): void {
    const t = Date.now();
    let dt = (t - state.lastTickAt) / 1000;
    state.lastTickAt = t;
    if (dt < 0) dt = 0;
    dt = Math.min(dt, OFFLINE_CAP_HOURS * 3600);
    if (leader.active && dt > 0) tick(state, dt * speed, ctx);
    renderer.draw(cfg, graph, state, t);
    requestAnimationFrame(frame);
  }

  window.setInterval(() => {
    refreshUI();
    if (leader.active && Date.now() - lastSavedAt > 5000) {
      saveState(state);
      lastSavedAt = Date.now();
    }
  }, 250);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && leader.active) {
      saveState(state);
      lastSavedAt = Date.now();
    }
  });

  refreshControls();
  refreshUI();
  el('boot').hidden = true;
  el('app').hidden = false;
  renderer.resize();
  renderer.fit();
  requestAnimationFrame(frame);

  // 控制台里留一个调试入口
  Object.assign(window as unknown as Record<string, unknown>, {
    sanwalk: {
      get state() {
        return state;
      },
      cfg,
      graph,
      tick: (sec: number) => tick(state, sec, ctx),
    },
  });
}

boot();
