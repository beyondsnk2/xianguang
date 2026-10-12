/**
 * 坐标点地图数据模型（坐标模式唯一真相）。
 *
 * 设计：xlsx 是坐标真相（城市 x/y 离散坐标 + cityLink 连线 + states 着色），
 * genPointMap.ts 由 xlsx 直读派生 point-map.json（仅作启动自动重生成的派生产物，
 * 供 checkPoint 一致性校验与人工核对），运行时不再由 ?pointmap 叠加、不再栅格化。
 */

/** 城市坐标点 */
export interface PointCity {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 所属州 tag（对应 states[].tag）；缺省不涂州色 */
  state?: string;
  /** 该城拥有的设施类型（nodeType 字符串）；缺省用空（由 xlsx 决定） */
  taskTypes?: string[];
}

export interface PointWaypoint {
  id: string;
  x: number;
  y: number;
}

export interface PointRoad {
  id: string;
  /** 参考点 id 序列（城市 id 或拐点 id），相邻两点连一段直线 */
  pointRefs: string[];
  /** 显式坐标折线 [[x,y]...]；与 pointRefs 二选一，优先级低于 pointRefs */
  points?: Array<[number, number]>;
}

export interface PointState {
  tag: string;
  name: string;
  /** #RRGGBB */
  color: string;
}

/** 矩形区域（分区 / 州 / 场景范围），坐标空间 */
export interface PointRegion {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 自定义填充色（#RRGGBB）；缺省用 state 色 */
  color?: string;
  /** 所属州 tag（用于取 state.color）；缺省用 color 或中性色 */
  state?: string;
}

export interface PointMapModel {
  meta: {
    name: string;
    width: number;
    height: number;
    /** 背景图文件名（public/ 下）；空串/缺省 → 程序化占位底图 */
    background?: string;
    /** 同上，更直白的字段名 */
    mapBgImg?: string;
    /** 缩放后网格最长边上限，默认 48 */
    gridMaxDim?: number;
  };
  cities: PointCity[];
  waypoints?: PointWaypoint[];
  roads: PointRoad[];
  states?: PointState[];
  /** 矩形区域（分区 / 州 / 场景）；缺省时按州聚合城市包围盒自动生成 */
  regions?: PointRegion[];
}
