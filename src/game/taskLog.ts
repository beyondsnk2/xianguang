/**
 * 任务明细录制器（**不入存档**，只在需要统计时挂到 TickCtx 上）。
 *
 * 设计约束：`GameState` 是要写 localStorage 的，逐任务明细会把它撑爆，
 * 所以明细一律走这个旁路收集器，由调用方决定是否启用。
 * 不启用时 `TickCtx.recorder === undefined`，结算逻辑一行都不多跑。
 */

import type { AttrKey } from './types';

export interface RewardItem {
  tag: string;
  n: number;
}

export interface TaskRecordInput {
  taskTag: string;
  taskName: string;
  cls: string;
  quality: number;
  workSec: number;
  evalName: string;
  evalTier: number;
  evalMult: number;
  rewards: RewardItem[];
  /**
   * 本次任务发放的**属性**经验。V4 R1 删掉临时属性桥后恒为空（四维只由随机事件积累，
   * 见 `event.ts` 结算段）；字段保留仅为兼容旧版明细表的列顺序，勿据此判断属性来源。
   */
  attrXp?: Partial<Record<AttrKey, number>>;
  skill: string;
  skillXp: number;
}

export interface TaskRecord extends TaskRecordInput {
  /** 角色序号（第几个模拟角色） */
  charId: number;
  /** 路上用时（秒）：格数 × speed，等于 moving 阶段的 phase.total */
  travelSec: number;
  /** 该角色内的完成顺序，从 1 开始 */
  seq: number;
}

export class TaskRecorder {
  readonly records: TaskRecord[] = [];
  private readonly travel = new Map<number, number>();

  constructor(readonly charId: number) {}

  /** moving 阶段结算时登记路程耗时 */
  noteTravel(taskId: number, sec: number): void {
    this.travel.set(taskId, sec);
  }

  record(input: TaskRecordInput, taskId: number): void {
    this.records.push({
      ...input,
      charId: this.charId,
      travelSec: this.travel.get(taskId) ?? 0,
      seq: this.records.length + 1,
    });
    this.travel.delete(taskId);
  }
}
