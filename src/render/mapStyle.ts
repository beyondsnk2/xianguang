/**
 * mapStyle.ts —— 地图渲染视觉常量集中地（V3 写实化渲染）。
 * 文档《V3地图渲染开发_v1.md》要求：所有配色 / 线宽系数等魔法数集中到此文件，
 * render/map.ts 不得散落魔法数。
 *
 * 仅存放「只读常量 + 与配置无关的兜底表」，不引入运行期状态。
 *
 * 2026-10-14 清理：格子时代遗留常量已整对象删除——
 *   - BLOCK（城块烘焙/文明区距离场）：坐标模式无格子烘焙，无消费者
 *   - SMOOTH（格子路径平滑）：路径即坐标折线，无需 DP/Catmull-Rom 重采样
 *   - NODE 设施点/州名字段：坐标模式只画拐点 + 城郭，设施信息走城市弹窗
 *   - ROAD.widthMin / NEUTRAL_BLOCK：仅格子分支使用，随分支删除
 */

/** L0 背景层 */
export const BG = {
  /** 程序化占位：低频渐变三段（暗色绢帛） */
  gradient: ['#2B2E26', '#23261F', '#1D201B'] as [string, string, string],
  /** 云纹光斑数量 */
  cloudSpots: 26,
  /** 云纹光斑 alpha */
  cloudAlpha: 0.16,
  /** 云纹光斑颜色 */
  cloudColor: 'rgba(210,205,180,1)',
  /** @deprecated 背景图浓度改由 config.bg1Opacity 控制（见 render/map.ts drawBgImage），此常量不再使用 */
  darken: 'rgba(10,12,8,0.35)',
  /** 晕影最深色 */
  vignette: 'rgba(8,10,6,0.5)',
} as const;

/** L2 道路层（双层描边） */
export const ROAD = {
  /** 底层（暗色描边） */
  halo: 'rgba(92,68,38,0.34)',
  /** 上层（米白主色） */
  bright: 'rgba(234,220,180,0.95)',
  /** 线宽系数（× 每坐标单位像素 s；坐标空间下 s 极小，道路主干用固定像素宽，见 drawRoads） */
  widthK: 0.16,
} as const;

/** L3 节点层 */
export const NODE = {
  /** 城郭图标宽 = s × 该系数 */
  cityGlyphW: 1.5,
  /** 城郭图标高 = s × 该系数 */
  cityGlyphH: 1.1,
  /** 城郭整体缩放（锚点 = 2×2 中心） */
  cityGlyphScale: 0.9,
  /** 城名显示的最小 s（s>此值才画城名） */
  cityNameMinS: 7,
  /** 城郭填充 */
  cityFill: '#F2EDDC',
  /** 城郭描边 */
  cityStroke: '#3A3226',
  /** 城郭中央朱红块 */
  cityCore: '#8C3A2E',
} as const;

/** L4 动态层 */
export const DYN = {
  /** 已走过路径 alpha（剩余段亮色） */
  traveledAlpha: 0.35,
  /** 角色半径下限（像素） */
  charRadiusMin: 6,
  /** 角色半径系数（× s） */
  charRadiusK: 0.42,
  /** 角色光晕颜色（径向渐变内圈） */
  charGlow: 'rgba(245,247,251,0.7)',
  /** 角色光晕倍率（× r） */
  charGlowK: 3.8,
  /** 角色描边衬底颜色（白点外先画一圈深色底，保证任意背景可辨） */
  charOutline: '#11141b',
  /** 角色描边衬底倍率（× r） */
  charOutlineK: 1.55,
  /** 定位环脉冲颜色 */
  charPing: 'rgba(120,200,255,0.9)',
  /** 定位环脉冲周期（ms） */
  charPingPeriod: 1400,
  /** 定位环基础半径倍率（× r，静态呼吸圈） */
  charPingBaseK: 2.1,
  /** 定位环扩散最大倍率（× r，扩散圈） */
  charPingSpreadK: 4.6,
  /** 角色锚定实环倍率（× r，steady 蓝环，让位置“锁住”清晰） */
  charAnchorK: 1.8,
  /** 移动亮色（品红，与暖米色道路强反差） */
  movingBright: '#ff4fa3',
  /** 移动已走底色（深品红） */
  movingBase: 'rgba(200,40,120,0.4)',
} as const;

/** 设施类型 → 兜底中文名（配置 tasks 表缺 nodeName 时用） */
export const FAC_FALLBACK: Record<string, string> = {
  mine: '矿场',
  herb: '药圃',
  nanyao: '南药谷',
  hunt: '猎场',
  smith: '铁匠铺',
  alchemy: '丹房',
  workshop: '机巧坊',
  temple: '道观',
  hut: '隐庐',
  ground: '校场',
  tavern: '酒肆',
  embassy: '使馆',
  barrack: '兵营',
  market: '街市',
  farmland: '农田',
  academy: '学堂',
};
