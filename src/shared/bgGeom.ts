/**
 * bgGeom.ts —— 底图几何唯一真相（游戏渲染 / 地图编辑器共用）。
 *
 * 背景：此前「编辑器所见」与「游戏所见」参数相同却效果不同，根因是两边
 * 各自实现了一遍底图变换且基准不同：
 *   - 游戏 render/map.ts：基准 = 城市+拐点包围盒（无 pad），图像 cover 铺满
 *   - 编辑器 editor.ts：基准 = bounds（节点包围盒 + pad 8），preserveAspectRatio=none 硬拉伸
 * 本模块把该几何抽为纯函数，两边只保留「渲染」不再保留「几何」：
 * 编辑器里调好的底图，就是游戏里看到的样子。
 *
 * 模型（与 game/types.ts Bg1Config 注释一致）：
 *   基准矩形 = 全部点位（城市 + 拐点）包围盒，无 pad；
 *   图像先按基准矩形 cover 铺满（保持宽高比，max 比例），
 *   再按 scaleW / scaleH 围绕基准中心缩放，
 *   最后按 offsetX / offsetY 整体平移。
 *
 * 约束：纯函数、零 DOM / canvas / svg 依赖，可被浏览器与 node 工具链共用。
 */

/** 点位（城市 / 拐点通用，只要 x/y） */
export interface BgPoint {
  x: number;
  y: number;
}

/** 底图变换参数（config.bg1* 系列；编辑器 bgState 同构） */
export interface BgTransform {
  /** 宽缩放倍率（1 = cover 基准；<=0 或非有限值按 1） */
  scaleW: number;
  /** 高缩放倍率（1 = cover 基准；<=0 或非有限值按 1） */
  scaleH: number;
  /** 整体平移 X（坐标空间单位） */
  offsetX: number;
  /** 整体平移 Y（坐标空间单位） */
  offsetY: number;
}

/** 坐标空间矩形 */
export interface BgRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const fin = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/**
 * 点位集合包围盒（无 pad）。空集合返回 null。
 * 单个点 → 零宽高矩形（w/h = 0；调用方按需兜底）。
 */
export function pointsBounds(pts: readonly BgPoint[]): BgRect | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 底图终态矩形（坐标空间）：给定点位集合、图像像素尺寸与变换参数，
 * 返回图像应当占据的矩形。游戏 canvas drawImage 与编辑器 SVG image 共用。
 *
 * 空点位集合 / 图像尺寸非正 → null（调用方走各自的兜底：游戏程序化占位底图，
 * 编辑器隐藏该图层）。
 */
export function bgImageRect(
  t: BgTransform,
  pts: readonly BgPoint[],
  imgW: number,
  imgH: number,
): BgRect | null {
  const b = pointsBounds(pts);
  if (!b) return null;
  if (!(imgW > 0) || !(imgH > 0)) return null;
  // 基准矩形零宽/高（全部点位重合）时 cover 无意义 → 夹一个极小正值，
  // 与 render/map.ts 原 bgRect 的 Math.max(1e-6, …) 行为一致
  const bw = Math.max(1e-6, b.w);
  const bh = Math.max(1e-6, b.h);
  // cover：保持图像宽高比铺满基准矩形（与编辑器旧「硬拉伸」行为的差异即在此）
  const cover = Math.max(bw / imgW, bh / imgH);
  const scaleW = fin(t.scaleW, 1) > 0 ? fin(t.scaleW, 1) : 1;
  const scaleH = fin(t.scaleH, 1) > 0 ? fin(t.scaleH, 1) : 1;
  const w = imgW * cover * scaleW;
  const h = imgH * cover * scaleH;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return {
    x: cx - w / 2 + fin(t.offsetX, 0),
    y: cy - h / 2 + fin(t.offsetY, 0),
    w,
    h,
  };
}
