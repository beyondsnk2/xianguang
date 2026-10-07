/** 不在配置表里的常量（开发文档 §九 待定项建议值） */

import type { AttrKey } from './types';

/** 空槽补位周期（秒）。配置表暂无此字段，V1 先用 180 s */
export const REFILL_SEC = 180;

/** 离线收益上限（小时）。建议 8–12，取 8 */
export const OFFLINE_CAP_HOURS = 8;

/** 单次 tick 允许结算的最大事件数（防御死循环） */
export const MAX_TICK_EVENTS = 200_000;

/** 存档结构版本（V2 引入技能/好感/图纸字段升到 2；V4 引入金钱字段升到 3；版本不符直接弃档重开） */
export const SAVE_VERSION = 3;

/** V4 初始金钱（文）。config 表有 initMoney 时以表为准 */
export const INIT_MONEY = 500;

/** E0 任务工钱系数：wage = round(price[材料|tier] × WAGE_RATIO)。Q-V4-11 已定 1.0（锚定基准价）。⚠ R5 之后回调 */
export const WAGE_RATIO = 1.0;

/** E0 事件赏金系数：bounty = round(price[材料|tier] × BOUNTY_MULT)。
 *  Q-V4-9 设计目标 工钱:赏金 ≈ 7:3；校准 sim（随机选选项的玩家上界）实测 120d 工钱:赏金 78:22（BOUNTY_MULT=10），
 *  把系数提到 15 → 赏金占比升到 ~30%，贴合 7:3。（本版临时调平，后续重做紧张经济时整体回调） */
export const BOUNTY_MULT = 15;

/** 存档 key */
export const SAVE_KEY = 'sanwalk.save.v1';

/** 日志保留条数 */
export const LOG_LIMIT = 40;

/**
 * 事件流保留条数（事件流取代普通日志展示，超出丢弃最旧的）。
 * 200：任务日志量很大（每日 ~167 条），容量太小会把稀有事件与事件触发记录挤出流，
 * 导致"刚才发生了什么"查不到。单条约百字节，200 条对存档体积可忽略。
 */
export const EVENT_LIMIT = 200;

/** 地图逻辑尺寸（配置表里没有，V1 遗留常量；渲染与寻路均已从 config 推导，勿新引用） */
export const MAP_W = 36;
export const MAP_H = 30;

// ─────────────────────────── V2 技能 / 品质 / 评价 常量 ───────────────────────────

/** 技能等级上限 100 级 = 10 档 */
export const SKILL_MAX_LV = 100;
export const SKILL_TIER_SIZE = 10;

/**
 * 技能经验：每次完成对应技能的任务，给 `SKILL_XP_PER_QUALITY × 品质`。
 * 按 needTime 随品质升长（20→60s）做补偿，使单位时间经验大致恒定。
 * 2 是按 D4 基准反推的取值：第 1 天 ~Lv5-7、第 16 天前后 Lv30（与「属性约 16 天到 Lv29-30」同节奏）、
 * 约 2 个月触 Lv100 顶。要改节奏只动这一个常量。
 */
export const SKILL_XP_PER_QUALITY = 2;

/** 滑动窗口宽度：每档只开放 3 种品质；下沿 min(档位,7)，8 档及以上触顶 7-9 */
export const QUALITY_WINDOW_SIZE = 3;
export const QUALITY_WINDOW_TOP_TIER = 7;

/** 窗口内三档权重（低→高）：低档 50/35/15，高档 20/30/50，中间档线性插值 */
export const QUALITY_WEIGHT_LOW: readonly number[] = [50, 35, 15];
export const QUALITY_WEIGHT_HIGH: readonly number[] = [20, 30, 50];

/** 评价四档默认增量（拙/平/佳/绝）；配置 task.evalInc 缺失时用这一组 */
export const DEFAULT_EVAL_INC: readonly number[] = [0, 0.3, 0.6, 1.0];
export const EVAL_NAMES: readonly string[] = ['拙', '平', '佳', '绝'];

/** cls → 主力属性映射（统帅不进评价，作全局节拍器） */
export const CLS_TO_ATTR: Record<string, AttrKey> = {
  A: 'force',
  B: 'intelligent',
  C: 'politics',
};

// ── C 类产出（Q21 未敲项，先用占位口径，集中在这一处便于调） ──

/** 好感：每任务保底 + 品质 + 评价档 */
export const FAVOR_PER_TASK = 1;

// ── 人物关系「事迹传播」（F28：完成任务按属性一对多涨相关武将好感） ──
// 每个任务完成会"展示"其主属性（A←武力 / B←智力 / C←政治，统帅按概率），
// 仅对已结识武将按偏好权重涨好感；攻略对象再乘加权。集中在这一处便于调。

/** 名气底噪：设为 0，避免所有人"自动被认识"——正式结识只由 C 类「初识事件」触发 */
export const REL_AMBIENT = 0;
/** 主偏好命中展示属性时的额外好感 */
export const REL_MAIN_BONUS = 1.2;
/** 次偏好命中展示属性时的额外好感 */
export const REL_SUB_BONUS = 0.5;
/** 攻略对象（玩家选定）的总好感倍率 */
export const REL_TARGET_MULT = 2;

// ── C 类任务「初识事件」：随机偶遇一位素未谋面的武将，正式建立关系 ──
/** 初识时一次性注入的好感（使其进入「初识」阶段） */
export const REL_FIRST_MEET = 8;
/** 每次 C 类任务触发初识事件的概率 */
export const REL_FIRST_MEET_CHANCE = 0.35;
/** 稀有材料：品质 ≥ 4 的 C 任务才可能产出（item 表稀有只有 4-9 品） */
export const RARE_MIN_QUALITY = 4;
/**
 * V5：单次 C 任务产出的稀有件数（按品质递增 1→3）。
 * 旧值恒为 1。V5 给 B 制造加了「额外层」——每笔制造要两个稀有（基础 + 额外），
 * 且两个稀有独立稀缺、缺料率按乘法叠加（0.44² ≈ 0.19 才对上实测 75% 停产）。
 * 故 C 侧必须同步抬量，否则高阶制造线整体瘫痪。
 */
export function rareCountByQuality(q: number): number {
  if (q <= 5) return 1;
  if (q <= 7) return 2;
  return 3;
}
/**
 * 图纸：品质 ≥ 4 + 评价 ≥ 佳 + 好感达标才解锁。
 * V5：品质门槛由 7 下移到 4 —— 制造侧 q1-3 天生会、q4 起全部需要图纸，
 * 若掉落仍从 q7 开始，中段玩家会长期无图可造（实现边界①）。
 */
/**
 * V5：额外层是「加成」不是「门槛」。
 * 基础料 + 基础稀有齐备即可开工；额外料齐备时**额外产出**，最多多产 `cycles × 本比例` 件。
 * （旧实现是四项齐备才开造，缺料率被两个稀有按乘法叠加推到 51%，故改为加成。）
 */
export const EXTRA_BONUS_RATIO = 1.0;
export const BLUEPRINT_MIN_QUALITY = 4;
export const BLUEPRINT_MIN_EVAL_TIER = 2;
export const BLUEPRINT_MIN_FAVOR = 30;
/** 名品：上品 C 任务的小概率产出（对应 3 件名品） */
export const MINGQI_MIN_QUALITY = 7;
export const MINGQI_MIN_EVAL_TIER = 2;
export const MINGQI_CHANCE = 0.05;

// ── 随机事件（内容设计 §三/§七 已定决议） ──
/**
 * 待处理事件容器的**硬上限**（防御性，防止无限堆积）。
 * 超过此值不再生成新事件，并提示"列表已满"。真正"保底不被超时丢弃"的
 * 数量见 `EVENT_KEEP_MIN`——只要待处理数 ≤ EVENT_KEEP_MIN，即使超过 4h 时限也不丢。
 */
export const EVENT_CONTAINER_CAP = 50;
/** 待处理事件**保底保留**数量：这 N 条即使超过 4h 时限也不会被 `expireEvents` 丢弃，确保离线再久回来也至少能看到/处理 N 条 */
export const EVENT_KEEP_MIN = 10;
/** 时限：首版**统一** 4 小时（不做分层） */
export const EVENT_TTL_SEC = 4 * 3600;
/** 时间源事件点的「初始/默认」目标间隔（秒）；实际间隔每次触发后于 [EVENT_GAP_MIN, EVENT_GAP_MAX] 随机重摇，期望 600 */
export const EVENT_POINT_SEC = 600;
/** 时间源随机间隔下界（秒）= 5 分钟 */
export const EVENT_GAP_MIN = 5 * 60;
/** 时间源随机间隔上界（秒）= 15 分钟 */
export const EVENT_GAP_MAX = 15 * 60;
/** 每日在线事件上限 */
export const EVENT_DAILY_CAP = 9999;
/** 行为源：完成品质 ≥ 此值的任务触发一次机会 */
export const EVENT_TRIGGER_QUALITY = 7;

/** C 类技能 → 名品 tag（item 表未给映射，暂由代码登记；接人物系统后应迁入配置） */
export const MINGQI_BY_C_SKILL: Record<string, string> = {
  sworn: 'mingqi_jade',
  visiting: 'mingqi_talisman',
  envoy: 'mingqi_exotic',
};

// ─────────────────────────── 事迹展示（F28） ───────────────────────────

/**
 * 事迹传播时「额外展示统帅」的概率。
 * ⚠ 这是**武将关系**用的常量（`generals.ts::propagateDeed`），不是属性桥。
 * 原 `ATTR_LEAD_CHANCE` 是临时桥给玩家涨统帅的概率，桥已删（V4 R1），此常量改名保留。
 */
export const DEED_LEAD_CHANCE = 0.3;

// ── B 类效率收益（同评价下省料） ──

/** 评价「绝」时材料消耗 −25%，按 evalInc 线性缩放 */
export const EFF_SAVE_AT_BEST = 0.25;
