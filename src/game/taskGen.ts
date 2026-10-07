import type { CityDef, GameConfig, MapNodeDef, Task, TaskDef } from './types';
import { pickOne, randFloat } from './rng';
import type { AmbitionKey, GameState, PaceKey } from './types';
import { qualityWeights, qualityWindow, skillTier } from './skill';

/**
 * 抱负 → 偏好技能集合（设计 §8.6）。
 * 每抱负 = 1A 采集 + 1B 制造 + 1C 人物，四抱负并集覆盖全部 9 技能、无暗偏。
 * `free` 为空 → 全技能等概率（旧档/未选抱负时）。
 */
export const AMBITION_SKILLS: Record<AmbitionKey, string[]> = {
  free: [],
  wen: ['herbalism', 'alchemy', 'visiting'],
  wu: ['hunting', 'smithing', 'sworn'],
  zong: ['mining', 'crafting', 'envoy'],
  fang: ['herbalism', 'alchemy', 'sworn'],
};

/** 偏好技能相对权重（其余为 1）→ 约 2/3 生成任务的技能落在抱负集合内 */
const AMBITION_SKILL_WEIGHT = 4;

/** 节奏 → 品质窗口偏移（钳制在 1–9）：稳压低、搏抬高，不绑死抱负 */
export const PACE_OFFSET: Record<PaceKey, number> = {
  steady: -1,
  mid: 0,
  bold: 1,
};

export interface TaskIndex {
  /** nodeType → 拥有该设施的城市 */
  citiesByNodeType: Map<string, CityDef[]>;
  /** `${cityTag}/${nodeType}` → 节点 */
  nodeByCityType: Map<string, MapNodeDef>;
  /** V2：技能 tag → 该技能的任务（按品质升序）；V1 配置无 skill 列时为空 */
  tasksBySkill: Map<string, TaskDef[]>;
  /** 有可用设施节点的任务（生成时的候选池） */
  availableTasks: TaskDef[];
  /** 有候选任务的技能 tag 列表 */
  skillTags: string[];
}

export function buildTaskIndex(cfg: GameConfig): TaskIndex {
  const citiesByNodeType = new Map<string, CityDef[]>();
  for (const city of cfg.cities) {
    for (const t of city.taskTypes) {
      const list = citiesByNodeType.get(t) ?? [];
      list.push(city);
      citiesByNodeType.set(t, list);
    }
  }
  const nodeByCityType = new Map<string, MapNodeDef>();
  for (const node of cfg.nodes) {
    if (!node.belong || node.name === 'city') continue;
    nodeByCityType.set(`${node.belong}/${node.name}`, node);
  }

  /** 任务至少能被一座城市承接（城市有该设施且有对应节点） */
  const placeable = (t: TaskDef): boolean => {
    const cities = citiesByNodeType.get(t.nodeType) ?? [];
    return cities.some((c) => nodeByCityType.has(`${c.tag}/${t.nodeType}`));
  };

  const availableTasks = cfg.tasks.filter(placeable);

  const tasksBySkill = new Map<string, TaskDef[]>();
  for (const t of availableTasks) {
    if (!t.skill) continue;
    const list = tasksBySkill.get(t.skill) ?? [];
    list.push(t);
    tasksBySkill.set(t.skill, list);
  }
  for (const list of tasksBySkill.values()) list.sort((a, b) => a.quality - b.quality);

  return {
    citiesByNodeType,
    nodeByCityType,
    tasksBySkill,
    availableTasks,
    skillTags: [...tasksBySkill.keys()],
  };
}

/** 加权抽取（权重数组与候选等长） */
function pickWeighted<T>(state: GameState, items: T[], weights: number[]): T | null {
  if (!items.length) return null;
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return pickOne(state, items);
  let x = randFloat(state) * total;
  for (let i = 0; i < items.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * V2 任务生成：等概率抽技能 → 该技能档位对应的 3 品窗口内加权抽品质 → 从有该设施的城市里抽一座。
 * 技能初始 tier 1（品质 1–3），随技能升级窗口上移，8 档触顶 7–9。
 * 兼容：配置无 skill/quality 列（V1）时，回退为「等概率抽全部可用任务」。
 */
/**
 * V5：某 B 类任务在本品质下「玩家已解锁」的物品族列表。
 * 判定：该族在本品质的配方存在，且（不需要图纸 或 玩家已持有该图纸）。q1-3 天生会。
 * @returns 族 tag 数组；**null = 老配置（subOutput 不是族列表，或该品质查不到任何族配方）→ 调用方不启用新逻辑**
 */
function unlockedFams(state: GameState, cfg: GameConfig, def: TaskDef): string[] | null {
  const fams = (def.subOutput || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!fams.length) return null;
  const out: string[] = [];
  let anyRecipe = false;
  for (const f of fams) {
    const r = cfg.recipeByResult[`${f}_${def.quality}`];
    if (!r) continue;
    anyRecipe = true;
    if (!r.needBlueprint || state.blueprints.includes(r.needBlueprint)) out.push(f);
  }
  return anyRecipe ? out : null; // 一条族配方都对不上 → 判为老配置，不拦
}

export function genTask(state: GameState, cfg: GameConfig, idx: TaskIndex): Task | null {
  const taskDef = pickTaskDef(state, cfg, idx);
  if (!taskDef) return null;
  const cities = idx.citiesByNodeType.get(taskDef.nodeType) ?? [];
  const city = pickOne(state, cities);
  if (!city) return null;
  const node = idx.nodeByCityType.get(`${city.tag}/${taskDef.nodeType}`);
  if (!node) return null;
  // B 类：刷出任务时就锁定实际制造目标（已解锁族中随机）
  const fams = taskDef.cls === 'B' ? unlockedFams(state, cfg, taskDef) : null;
  const outputTag = fams && fams.length ? `${pickOne(state, fams)}_${taskDef.quality}` : undefined;
  return {
    id: state.nextTaskId++,
    taskTag: taskDef.tag,
    cityTag: city.tag,
    nodeTag: node.tag,
    needTime: taskDef.needTime,
    outputTag,
  };
}

function pickTaskDef(state: GameState, cfg: GameConfig, idx: TaskIndex): TaskDef | null {
  if (!idx.skillTags.length) return pickOne(state, idx.availableTasks);

  // 抱负加权：偏好的技能获得更高权重；free 全平等
  const ambSkills = AMBITION_SKILLS[state.ambition] ?? [];
  const skillWeights = idx.skillTags.map((s) => (ambSkills.includes(s) ? AMBITION_SKILL_WEIGHT : 1));
  const skill = pickWeighted(state, idx.skillTags, skillWeights);
  if (!skill) return null;
  const all = idx.tasksBySkill.get(skill) ?? [];
  if (!all.length) return null;

  const prog = state.skills[skill];
  const tier = skillTier(prog ? prog.lv : 1);
  // 节奏偏移品质窗口（不绑死抱负，规避跨抱负品质失衡）；钳制到 [1,9] 且 min<=max
  const base = qualityWindow(tier);
  const off = PACE_OFFSET[state.pace] ?? 0;
  const lo = Math.max(1, Math.min(8, base.min + off));
  const hi = Math.max(lo, Math.min(9, base.max + off));
  const win = { min: lo, max: hi };
  const inWindow = all.filter((t) => t.quality >= win.min && t.quality <= win.max);
  let candidates = inWindow.length ? inWindow : all; // 窗口异常空 → 退回全技能池，不刷不出任务

  // B 类实现边界②：只保留「本品质有已解锁物品族」的任务。
  // 若全部被图纸卡住 → 回退该技能的初段（q1-3 天生会），保证有事可做而不是空转。
  if (candidates.length && candidates[0].cls === 'B') {
    const marks = candidates.map((t) => unlockedFams(state, cfg, t));
    if (marks.some((m) => m !== null)) {
      // 确认为新结构配置（至少一条能对上族配方）→ 启用过滤
      const ok = candidates.filter((_t, i) => marks[i] === null || marks[i]!.length > 0);
      if (ok.length) {
        candidates = ok;
      } else {
        const fallback = all.filter((t) => t.quality <= 3);
        if (!fallback.length) return null;
        candidates = fallback;
      }
    }
  }
  if (candidates.length === 1) return candidates[0];

  const weights = qualityWeights(tier);
  // 候选按品质升序，权重按顺序对齐；窗口宽 3 时即 [低, 中, 高]
  const w = candidates.map((_t, i) => weights[Math.min(weights.length - 1, i)]);
  return pickWeighted(state, candidates, w);
}
