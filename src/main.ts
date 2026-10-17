import { loadGameConfig } from './config/loader';
import { buildVGraph } from './game/vgraph';
import { buildTaskIndex, type TaskIndex } from './game/taskGen';
import { createInitialState, ensureRuntimeFields, normalizeSlots, pushLog, storageItemCount } from './game/state';
import { syncPhase, tick, type TickCtx } from './game/tick';
import { loadState, saveState, clearSave, hasSave, TabLeader } from './game/save';
import { runSelfCheck } from './game/selfcheck';
import { OFFLINE_CAP_HOURS, SAVE_VERSION } from './game/constants';
import { canSwitchClass, setActiveClass } from './game/classSystem';
import type { GameConfig, GameState } from './game/types';
import { MapRenderer } from './render/map';
import { autoSort, TaskBoard, computeTotalSeconds, flashTotalDelta } from './ui/taskList';
import {
  renderBag,
  renderCharacter,
  renderCheck,
  renderControls,
  renderEvents,
  renderFeed,
  renderRelations,
  renderTaskbar,
  renderTopStats,
  relView,
  charView,
  floatReward,
  toast,
} from './ui/panels';
import type { EventResult } from './game/event';
import { eventWatermark } from './game/events';
import { resolveEvent } from './game/event';
import { fmtDur } from './ui/format';
import { buildCityInfo, cityPopBodyHtml, cityTipHtml, placePopover, placeTip } from './ui/cityPopover';

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
  // 坐标模式：向量图是唯一路径（xlsx 直出城市坐标 + 连线）
  const vgraph = buildVGraph(cfg);
  if (!vgraph) {
    bootText.textContent = '地图构建失败：缺少城市坐标或连线，请检查 xlsx 的 mapPoint / mapPointLink 表';
    return;
  }
  const taskIndex: TaskIndex = buildTaskIndex(cfg);
  const ctx: TickCtx = { cfg, vgraph, taskIndex };

  // 存档只要不是当前配置的（含没有 cfgKey 的老存档），直接删除并重开，不做兼容迁移
  const cfgKey = `${cfg.meta.setName}_V${cfg.meta.version}`;
  const oldSave = loadState();
  let state: GameState = oldSave ?? createInitialState(cfg, Date.now());
  if (oldSave && oldSave.cfgKey !== cfgKey) {
    clearSave();
    state = createInitialState(cfg, Date.now());
    pushLog(state, `配置切换到 ${cfgKey}，旧存档已丢弃`);
    toast(`配置已切换为 ${cfgKey}，旧存档已删除并重新开局`, 6000);
  } else if (!oldSave && hasSave()) {
    // 存档结构版本不符（loadState 已弃档）→ 明确告知，避免玩家以为是 bug
    clearSave();
    state = createInitialState(cfg, Date.now());
    pushLog(state, `存档结构版本不符（当前 v${SAVE_VERSION}），已重新开局`);
    toast(`存档版本已升级到 v${SAVE_VERSION}，旧存档无法兼容，已重新开局`, 6000);
  }
  // 配置槽位数变化时的最小迁移
  if (state.slots.length !== cfg.values.initTaskListSlot) {
    while (state.slots.length > cfg.values.initTaskListSlot) state.slots.pop();
    while (state.slots.length < cfg.values.initTaskListSlot) state.slots.push({ kind: 'empty', refillIn: 0 });
  }
  if (!state.log) state.log = [];
  ensureRuntimeFields(state, cfg); // 补齐 V2 字段（技能/好感/图纸/统计口径）
  normalizeSlots(state); // 老存档可能把空槽留在列表中段，读档时归位到队尾

  // ── 离线结算：本地时间戳 + 离散事件推进 + 上限 8 小时 ──
  const now = Date.now();
  let elapsed = (now - state.lastTickAt) / 1000;
  if (elapsed < 0) elapsed = 0; // 系统时间被改小，直接丢弃
  const capped = Math.min(elapsed, OFFLINE_CAP_HOURS * 3600);
  if (capped > 5) {
    const before = {
      tasks: state.stats.tasksDone,
      storage: storageItemCount(state),
    };
    tick(state, capped, ctx);
    const gained = storageItemCount(state) - before.storage;
    pushLog(state, `离线结算 ${fmtDur(capped)}：完成 ${state.stats.tasksDone - before.tasks} 个任务`);
    toast(
      `你离开了 ${fmtDur(elapsed)}${elapsed > capped ? `（离线收益上限 ${OFFLINE_CAP_HOURS} 小时，结算 ${fmtDur(capped)}）` : ''}：` +
        `完成 ${state.stats.tasksDone - before.tasks} 个任务，入仓 ${gained} 件`,
      8000,
    );
  }
  state.lastTickAt = Date.now();
  syncPhase(state, ctx);

  // ── 界面装配 ──
  const renderer = new MapRenderer(el<HTMLCanvasElement>('map'));
  // 向量地图用坐标空间尺寸
  renderer.setMapSize(cfg.mapBounds.w, cfg.mapBounds.h);
  renderer.fit();

  const board = new TaskBoard(el('task-board'), {
    onReorder: (from, to) => {
      if (from === to) return;
      const item = state.slots[from];
      if (!item || item.kind !== 'task') return;
      if (item.task.id === state.currentTaskId) return; // 队首锁定
      const before = computeTotalSeconds(state, cfg, vgraph);
      state.slots.splice(from, 1);
      state.slots.splice(to, 0, item);
      normalizeSlots(state); // 空槽始终留在队尾
      syncPhase(state, ctx);
      const after = computeTotalSeconds(state, cfg, vgraph);
      flashTotalDelta(Math.round((after - before) / 60));
      refreshUI();
    },
  });

  el('meta-line').textContent =
    `${cfg.meta.setName} V${cfg.meta.version} · ${cfg.meta.file} · 生效表 ${cfg.meta.sheets.length} 张 · ` +
    `${cfg.cityPoints.length} 城市点 / ${cfg.roadLines.length} 道路`;

  const checkResult = runSelfCheck(cfg, vgraph);
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

  // ── 左侧菜单弹窗：背包 / 角色 / 关系 ──
  let openModalKind: 'bag' | 'char' | 'rel' | 'event' | null = null;
  let seenSeq = 0; // 已读事件水位（离线结算后对齐，避免刷屏）
  let relBadge = false; // 关系面板是否有未读的初识/升阶
  /** 最近一次事件结算结果：面板内渲染"结果卡"，约 2.6 秒后自动移除 */
  let lastEventResult: EventResult | null = null;

  /** 左菜单「事件」角标显示待处理条数（比单纯红点信息量更大） */
  function syncEventBadge(): void {
    const dot = el('menu-event').querySelector('.mi-dot') as HTMLElement | null;
    const n = state.pending.length;
    if (dot) {
      dot.textContent = String(n);
      dot.hidden = n === 0;
    }
  }
  const menuButtons = ['menu-bag', 'menu-char', 'menu-rel', 'menu-event'] as const;
  function syncMenuActive(): void {
    const activeTag =
      openModalKind === 'bag'
        ? 'menu-bag'
        : openModalKind === 'char'
          ? 'menu-char'
          : openModalKind === 'rel'
            ? 'menu-rel'
            : openModalKind === 'event'
              ? 'menu-event'
              : null;
    for (const id of menuButtons) el(id).classList.toggle('active', id === activeTag);
  }
  function renderModal(force = false): void {
    if (!openModalKind) return;
    const body = el('modal-body');
    // 周期性刷新时，若焦点落在弹窗内的可交互控件（如下拉框）上则跳过，避免重建打断选择
    if (!force) {
      const ae = document.activeElement;
      if (ae && ae !== body && body.contains(ae)) return;
    }
    if (openModalKind === 'bag') renderBag(body, state, cfg);
    else if (openModalKind === 'char') renderCharacter(body, state, cfg);
    else if (openModalKind === 'rel') renderRelations(body, state, cfg);
    else renderEvents(body, state, cfg, lastEventResult);
  }
  function openModal(kind: 'bag' | 'char' | 'rel' | 'event'): void {
    openModalKind = kind;
    el('modal-title').textContent =
      kind === 'bag'
        ? '背包 / 仓库'
        : kind === 'char'
          ? '角色信息'
          : kind === 'rel'
            ? '关系 / 人物'
            : '事件';
    el('modal').classList.toggle('wide', kind === 'rel' || kind === 'event' || kind === 'char');
    if (kind === 'rel') {
      relBadge = false;
      el('menu-rel').classList.remove('has-dot');
    }
    if (kind === 'char') charView.tab = 'overview';
    if (kind === 'event') syncEventBadge();
    (el('modal-wrap') as HTMLElement).hidden = false;
    syncMenuActive();
    renderModal(true);
  }
  function closeModal(): void {
    openModalKind = null;
    (el('modal-wrap') as HTMLElement).hidden = true;
    syncMenuActive();
  }
  el('menu-bag').addEventListener('click', () => openModal('bag'));
  el('menu-char').addEventListener('click', () => openModal('char'));
  el('menu-rel').addEventListener('click', () => openModal('rel'));
  el('menu-event').addEventListener('click', () => openModal('event'));
  // 顶栏「事件」胶囊 → 直达事件列表（触发提示的一屏入口）
  el('top-stats').addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-open="event"]')) openModal('event');
  });
  el('modal-close').addEventListener('click', closeModal);
  el('modal-wrap').addEventListener('click', (ev) => {
    if (ev.target === el('modal-wrap')) closeModal(); // 点遮罩关闭
  });

  // ── 关系面板的事件委托（modal-body 内容每 250ms 重渲染，故监听挂在持久节点上） ──
  const modalBody = el('modal-body');
  modalBody.addEventListener('change', (ev) => {
    const sel = ev.target as HTMLSelectElement;
    if (sel.id === 'rel-target') {
      state.target = sel.value || null;
      renderModal(true);
    } else if (sel.id === 'ambition-select') {
      state.ambition = sel.value as GameState['ambition'];
      renderModal(true);
      refreshUI();
    } else if (sel.id === 'pace-select') {
      state.pace = sel.value as GameState['pace'];
      renderModal(true);
      refreshUI();
    } else if (sel.id === 'class-select') {
      const now = Date.now();
      if (!sel.value) {
        state.activeClass = null;
        renderModal(true);
        refreshUI();
      } else {
        const ok = setActiveClass(state, cfg, sel.value, now);
        if (!ok) {
          const chk = canSwitchClass(state, cfg, now);
          pushLog(state, chk.reason || '无法切换职业', now);
        } else {
          pushLog(state, `转职为「${cfg.classByTag[sel.value]?.name ?? sel.value}」`, now);
        }
        renderModal(true);
        refreshUI();
      }
    }
  });
  modalBody.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    // 角色面板：子标签切换 + 概览快照下钻
    const ct = t.closest('[data-char-tab]');
    if (ct) {
      charView.tab = (ct.getAttribute('data-char-tab') as typeof charView.tab) ?? 'overview';
      renderModal(true);
      return;
    }
    const cj = t.closest('[data-char-jump]');
    if (cj) {
      charView.tab = (cj.getAttribute('data-char-jump') as typeof charView.tab) ?? 'overview';
      renderModal(true);
      return;
    }
    // 随机事件：选择后直接结算（无小游戏）
    const evAct = t.closest('[data-ev-act]');
    if (evAct) {
      const id = Number(evAct.getAttribute('data-ev-act'));
      const optAttr = evAct.getAttribute('data-ev-opt');
      const opt = optAttr == null ? undefined : Number(optAttr);
      if (Number.isFinite(id)) {
        const res = resolveEvent(state, cfg, id, opt);
        if (res) {
          lastEventResult = res;
          // 稀有 / 传说额外飘字，放大惊喜；普通事件只走面板结果卡（不打扰）
          // 属性经验变化在结果卡内以经验条 + 增长动画呈现（见 renderResultCard）
          if (res.rarity >= 1) floatReward(res.lines, res.rarity);
        }
        renderModal(true);
        refreshUI();
      }
      return;
    }
    const btn = t.closest('[data-rel-target]');
    if (btn) {
      const v = btn.getAttribute('data-rel-target');
      state.target = v ? v : null;
      renderModal(true);
      return;
    }
    // 关系面板的筛选 / 排序
    const fac = t.closest('[data-rel-faction]');
    if (fac) {
      relView.faction = (fac.getAttribute('data-rel-faction') as typeof relView.faction) ?? 'all';
      renderModal(true);
      return;
    }
    const met = t.closest('[data-rel-met]');
    if (met) {
      relView.met = (met.getAttribute('data-rel-met') as typeof relView.met) ?? 'all';
      renderModal(true);
      return;
    }
    const sort = t.closest('[data-rel-sort]');
    if (sort) {
      relView.sort = (sort.getAttribute('data-rel-sort') as typeof relView.sort) ?? 'favor';
      renderModal(true);
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeModal();
      closeCityPop();
    }
  });

  function refreshUI(): void {
    // 结果卡只停留约 2.6 秒
    if (lastEventResult && Date.now() - lastEventResult.at > 2600) lastEventResult = null;
    renderTaskbar(el('taskbar'), state, cfg);
    renderTopStats(el('top-stats'), state, cfg, speed);
    renderModal();
    renderFeed(el('feed-body'), state);
    board.update(state, cfg, vgraph);
    if (popCity) renderCityPop(); // 弹窗内容随 250ms 周期刷新（距离/任务关联等动态值）
    syncEventBadge();
    drainEvents();
  }

  /**
   * 事件流 → toast 的闸门：只对「未读且稀有/传说」的事件弹提示。
   * seenSeq 在离线结算完成后对齐，因此离线期间堆积的事件只进流、不刷屏。
   */
  function drainEvents(): void {
    const events = Array.isArray(state.events) ? state.events : [];
    const fresh = events.filter((e) => e.seq > seenSeq);
    // 高倍速下事件会成批到达：此时只弹「传说」级，避免刷屏（其余仍完整进事件流）
    const toastFloor = fresh.length > 6 ? 2 : 1;
    let maxSeq = seenSeq;
    for (const e of fresh) {
      maxSeq = Math.max(maxSeq, e.seq);
      if (e.rarity >= toastFloor) toast(e.text, e.rarity >= 2 ? 7000 : 5200);
      if (e.kind === 'meet' || e.kind === 'favor') relBadge = true; // 左菜单红点
    }
    seenSeq = maxSeq;
    el('menu-rel').classList.toggle('has-dot', relBadge);
  }

  el('btn-autosort').addEventListener('click', () => {
    const before = computeTotalSeconds(state, cfg, vgraph);
    autoSort(state, cfg, vgraph);
    normalizeSlots(state);
    syncPhase(state, ctx);
    const after = computeTotalSeconds(state, cfg, vgraph);
    flashTotalDelta(Math.round((after - before) / 60));
    refreshUI();
    toast('已按最近邻重排（队首不动）');
  });
  el('btn-fit').addEventListener('click', () => renderer.fit());
  el('btn-zoomin').addEventListener('click', () => renderer.zoom(1.25));
  el('btn-zoomout').addEventListener('click', () => renderer.zoom(0.8));

  // ── 城市悬停 tooltip + 点击弹窗（地图锚定 popover） ──
  const mapPane = el('map-pane');
  const tipEl = el('city-tip');
  const popEl = el('city-pop');
  const popNameEl = el('city-pop-name');
  const popStateEl = el('city-pop-state');
  const popBadgeEl = el('city-pop-badge');
  const popBodyEl = el('city-pop-body');
  let tipCity: string | null = null; // 当前悬停城市（tooltip 内容缓存，同城不重建）
  let popCity: string | null = null; // 当前弹窗城市；null = 弹窗关闭

  const paneSize = (): { w: number; h: number } => {
    const r = mapPane.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  const localPos = (ev: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  function showTip(tag: string | null): void {
    if (tipCity === tag) return;
    tipCity = tag;
    if (!tag) {
      tipEl.hidden = true;
      tipEl.innerHTML = '';
      return;
    }
    const info = buildCityInfo(cfg, state, vgraph, tag);
    if (!info) {
      tipEl.hidden = true;
      return;
    }
    tipEl.innerHTML = cityTipHtml(info);
    tipEl.hidden = false;
  }
  function moveTip(ev: PointerEvent): void {
    if (tipEl.hidden || !tipCity) return;
    const pos = placeTip(paneSize(), localPos(ev), { w: tipEl.offsetWidth, h: tipEl.offsetHeight });
    tipEl.style.left = `${pos.x}px`;
    tipEl.style.top = `${pos.y}px`;
  }
  function closeCityPop(): void {
    if (!popCity) return;
    popCity = null;
    popEl.hidden = true;
    popBodyEl.innerHTML = '';
  }
  function openCityPop(tag: string): void {
    popCity = tag;
    popEl.hidden = false;
    showTip(null); // 弹窗优先，隐藏 tooltip 避免叠噪
    renderCityPop();
  }
  function renderCityPop(): void {
    if (!popCity) return;
    const info = buildCityInfo(cfg, state, vgraph, popCity);
    if (!info) {
      closeCityPop();
      return;
    }
    popNameEl.textContent = info.name;
    popStateEl.textContent = info.stateName ?? '';
    popStateEl.hidden = !info.stateName;
    popBadgeEl.textContent = info.isStart ? '出生地' : info.visited ? '已造访' : '未造访';
    popBadgeEl.className = `cp-badge ${info.isStart ? 'start' : info.visited ? 'on' : 'off'}`;
    popBodyEl.innerHTML = cityPopBodyHtml(info);
    positionCityPop();
  }
  function positionCityPop(): void {
    if (!popCity) return;
    const anchor = renderer.cityScreenPos(cfg, popCity);
    if (!anchor) {
      closeCityPop();
      return;
    }
    const pos = placePopover(paneSize(), anchor, { w: popEl.offsetWidth, h: popEl.offsetHeight });
    popEl.style.left = `${pos.x}px`;
    popEl.style.top = `${pos.y}px`;
  }

  // 地图交互：滚轮缩放 / 拖动平移 / 城市悬停 tooltip / 城市点击弹窗
  const canvas = el<HTMLCanvasElement>('map');
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoom(ev.deltaY < 0 ? 1.12 : 0.89, ev.clientX - rect.left, ev.clientY - rect.top);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  canvas.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX;
    downY = ev.clientY;
    showTip(null);
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add('dragging');
    canvas.style.cursor = ''; // 让位给 .dragging 的 grabbing
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) {
      renderer.pan(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
      return;
    }
    if (popCity || ev.buttons !== 0) return; // 弹窗打开时不刷 tooltip；仅响应无按键悬停
    const p = localPos(ev);
    const tag = renderer.hitCity(p.x, p.y, cfg);
    showTip(tag);
    canvas.style.cursor = tag ? 'pointer' : '';
    moveTip(ev);
  });
  const endDrag = () => {
    dragging = false;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', (ev) => {
    endDrag();
    // 位移 >5px 视为拖动平移，不触发点击（阈值区分点击与拖图）
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
    const p = localPos(ev);
    const tag = renderer.hitCity(p.x, p.y, cfg);
    if (tag) {
      if (popCity === tag) closeCityPop(); // 再点同一城 = 关闭
      else openCityPop(tag);
    } else {
      closeCityPop(); // 点地图空白处 = 关闭
    }
  });
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => showTip(null));

  // 点弹窗外关闭：地图面板内、画布以外的区域（浮层工具条/边角）
  mapPane.addEventListener('pointerdown', (ev) => {
    if (ev.target === canvas) return; // 画布点击由上面 pointerup 的阈值逻辑统一处理
    if (!(ev.target as HTMLElement).closest('#city-pop')) closeCityPop();
  });
  // 弹窗内：✕ 关闭；邻城按钮下钻切换（委托挂持久外壳，body 每 250ms 重渲染不丢点击）
  el('city-pop-close').addEventListener('click', closeCityPop);
  popEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-city]') as HTMLElement | null;
    if (btn?.dataset.city) openCityPop(btn.dataset.city);
  });

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
    renderer.draw(cfg, state, t);
    if (popCity) positionCityPop(); // 平移/缩放时弹窗跟随锚点城市，保持不脱锚
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

  // 离线结算产生的事件只进事件流，不弹 toast（对齐已读水位）
  seenSeq = eventWatermark(state);
  // 离线结算已完成；此后为在线推进 → 随机事件开始累积（离线冻结）
  ctx.online = true;
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
      vgraph,
      tick: (sec: number) => tick(state, sec, ctx),
    },
  });
}

boot();
