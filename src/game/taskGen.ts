import type { CityDef, GameConfig, MapNodeDef, Task } from './types';
import { pickOne } from './rng';
import type { GameState } from './types';

export interface TaskIndex {
  /** nodeType → 拥有该设施的城市 */
  citiesByNodeType: Map<string, CityDef[]>;
  /** `${cityTag}/${nodeType}` → 节点 */
  nodeByCityType: Map<string, MapNodeDef>;
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
  return { citiesByNodeType, nodeByCityType };
}

/**
 * V1 任务生成：6 类等概率 → 从支持该类的 2 座城里等概率选 1 → 定位设施节点。
 * （技能 / 装备 / 倾向的权重叠乘属 V2）
 */
export function genTask(state: GameState, cfg: GameConfig, idx: TaskIndex): Task | null {
  const taskDef = pickOne(state, cfg.tasks);
  if (!taskDef) return null;
  const cities = idx.citiesByNodeType.get(taskDef.nodeType) ?? [];
  const city = pickOne(state, cities);
  if (!city) return null;
  const node = idx.nodeByCityType.get(`${city.tag}/${taskDef.nodeType}`);
  if (!node) return null;
  return {
    id: state.nextTaskId++,
    taskTag: taskDef.tag,
    cityTag: city.tag,
    nodeTag: node.tag,
    needTime: taskDef.needTime,
  };
}
