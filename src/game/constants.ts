/** 不在配置表里的常量（开发文档 §九 待定项建议值） */

/** 空槽补位周期（秒）。配置表暂无此字段，V1 先用 180 s */
export const REFILL_SEC = 180;

/** 离线收益上限（小时）。建议 8–12，取 8 */
export const OFFLINE_CAP_HOURS = 8;

/** 单次 tick 允许结算的最大事件数（防御死循环） */
export const MAX_TICK_EVENTS = 200_000;

/** 存档结构版本 */
export const SAVE_VERSION = 1;

/** 存档 key */
export const SAVE_KEY = 'sanwalk.save.v1';

/** 日志保留条数 */
export const LOG_LIMIT = 40;

/** 地图逻辑尺寸（配置表里没有，按产品文档固定 36×30） */
export const MAP_W = 36;
export const MAP_H = 30;
export const CELL_PX = 30;
