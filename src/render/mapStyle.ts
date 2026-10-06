/**
 * mapStyle.ts —— 地图渲染视觉常量集中地（V3 写实化渲染）。
 * 文档《V3地图渲染开发_v1.md》要求：所有配色 / 线宽系数 / warp 幅度 / 烘焙分辨率 /
 * 文明区半径等魔法数集中到此文件，render/map.ts 不得散落魔法数。
 *
 * 仅存放「只读常量 + 与配置无关的兜底表」，不引入运行期状态。
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
  /** 背景图压暗叠层（cover 铺满后叠加，保证上层可读） */
  darken: 'rgba(10,12,8,0.35)',
  /** 晕影最深色 */
  vignette: 'rgba(8,10,6,0.5)',
} as const;

/** L1 城块层 */
export const BLOCK = {
  /** 烘焙分辨率（取目标画布 CSS 尺寸的 1/3 左右；60×45 地图 → 480×360） */
  bakeW: 480,
  bakeH: 360,
  /** 文明区半径 R（格）：距离场 ≤ R 即「城市 + 周边空地」 */
  civilizedRadius: 4,
  /** domain warp 幅度（格）：低频噪声位移；实测 3.4 稳定，4.5 会把贴边城块扭碎 */
  warpAmp: 3.4,
  /** domain warp 空间频率（/格） */
  warpFreq: 0.09,
  /** 城心 alpha（最高） */
  alphaCore: 0.66,
  /** 文明区边缘 alpha（最低） */
  alphaEdge: 0.3,
  /** 笔触细噪声幅度（±） */
  noiseAmp: 7,
} as const;

/** L2 道路层（双层描边） */
export const ROAD = {
  /** 底层（暗色描边） */
  halo: 'rgba(92,68,38,0.34)',
  /** 上层（米白主色） */
  bright: 'rgba(234,220,180,0.95)',
  /** 线宽下限（像素） */
  widthMin: 1.6,
  /** 线宽系数（× 每格像素 s） */
  widthK: 0.16,
} as const;

/** 路径平滑（L2 / L4 共用算法） */
export const SMOOTH = {
  /** Douglas-Peucker 容差（格） */
  dpTolerance: 0.28,
  /**
   * 法向弯曲幅度（格）。**默认 0 = 关闭**：
   * 共享走廊的多条曲线若各自加随机弯会互相穿插（无意义交叉），
   * 且幅度与短段长度同量级时 Catmull-Rom 会过冲成环（无意义小圈）。
   * 曲线的有机感由「路网本身走向 + Catmull-Rom 圆角」提供，足够且保真。
   */
  bendAmp: 0,
  /** Catmull-Rom 每段采样步数 */
  catmullSteps: 8,
  /** 相邻控制点最小间距（格）：更近则合并，防 Catmull-Rom 短段过冲成环 */
  minCtrlDist: 0.75,
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
  /** 设施点半径下限（像素） */
  facilityDotMin: 1.6,
  /** 设施点半径系数（× s） */
  facilityDotK: 0.14,
  /** 设施名首字显示的最小 s */
  facilityNameMinS: 16,
  /** 州名显示的最大 s（s<此值才画州名，放大后由城名接管） */
  stateNameMaxS: 14,
  /** 设施点颜色 */
  facilityDot: 'rgba(245,240,225,0.85)',
  /** 设施点描边 */
  facilityDotStroke: 'rgba(30,25,16,0.55)',
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
  /** 回城亮色（青绿，与暖米色道路强反差） */
  returningBright: '#2fe39a',
  /** 移动已走底色（深品红） */
  movingBase: 'rgba(200,40,120,0.4)',
  /** 回城已走底色（深青绿） */
  returningBase: 'rgba(40,170,120,0.4)',
} as const;

/** 旧配置（无 state 表）降级：城块用单色中性色 */
export const NEUTRAL_BLOCK = '#6E7459';

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


