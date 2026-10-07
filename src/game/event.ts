/**
 * 随机事件（内容设计见 `doc/V2/设计_V2随机事件内容_v1.md`）。
 *
 * 首版范围（已定决议）：
 *  - 只做可落地的 5 类：①风土见闻 / ②路人遭遇 / ③旅途二选一 / ④奇遇 / ⑤地盘事件
 *  - 精编 60 条，靠 {city} 变量在 42 城复用
 *  - 容器 ≤10、时限统一 4h、**离线冻结**（只在线生成与计时）
 *  - 双源触发：时间源（在线每 10 分钟）+ 行为源（到达新城市 / 首次造访设施 / 完成品质≥7 任务）
 *  - 权重闸门：技能(Q11) + 人物好感 + 属性补偿(F19c)（称号未实现，预留）
 *  - 交互只有 none/binary/multi，**不做小游戏**，选择后直接结算
 *  - 结算：属性经验（与任务侧并存）+ 事迹传播 + 指定武将好感（关系 0 视为初识）+ 物品 + 见闻
 */
import {
  EVENT_CONTAINER_CAP,
  EVENT_DAILY_CAP,
  EVENT_GAP_MAX,
  EVENT_GAP_MIN,
  EVENT_KEEP_MIN,
  EVENT_POINT_SEC,
  EVENT_TTL_SEC,
  REL_FIRST_MEET,
} from './constants';
import { addAttrXp } from './attrGain';
import { addSkillXp, skillTier } from './skill';
import { addItem } from './inventory';
import { tierPrice } from './economy';
import { BOUNTY_MULT } from './constants';
import { emitEvent } from './events';
import {
  maybeFirstMeet,
  propagateDeedAttrs,
  GENERALS,
  generalByTag,
} from './generals';
import { pickOne, randFloat, randInt } from './rng';
import { ATTR_NAMES, type AttrKey, type GameConfig, type GameState } from './types';

export type EventType = 'jw' | 'en' | 'ch' | 'qy' | 'dp';

export const EVENT_TYPE_NAMES: Record<EventType, string> = {
  jw: '风土见闻',
  en: '路人遭遇',
  ch: '旅途二选一',
  qy: '奇遇',
  dp: '地盘事件',
};

/** 容器内的一条待处理事件 */
export interface PendingEvent {
  id: number;
  tag: string; // EventDef.tag
  at: number; // 生成时刻
  expireAt: number; // at + EVENT_TTL_SEC
  cityName?: string; // 供 {city} 变量替换
}

/** 交互分支（二选一 / 多选项） */
export interface EventOptionDef {
  text: string;
  attr?: AttrKey;
  xp?: [number, number];
  /** '*'=随机素未谋面者（初识）· '?'=随机已结识者 · 其余为武将 tag */
  favorNpc?: string;
  favor?: number;
  item?: string;
  itemNum?: number;
  jianwen?: string;
  jianwenName?: string;
  /** 方案2（属性经验 vs 技能经验）：本选项给「技能经验」（与 attr/xp 二选一或并存），须与事件主题贴合 */
  skill?: string;
  skillXp?: [number, number];
  /** E0b 赏金：本选项给「金钱」（同一事件至多一个 money 选项；选钱 = 放弃属性/物品/好感，红线⑤ 附则）。金额 = round(price[材料|玩家档位] × BOUNTY_MULT) */
  money?: boolean;
}

export interface EventDef {
  tag: string;
  type: EventType;
  title: string;
  text: string; // 支持 {city} 变量
  cities?: string[];
  facility?: string;
  npc?: string; // 需已结识
  skill?: string;
  skillLv?: number;
  weightBase: number;
  weightSkill?: number;
  onceOnly?: boolean;
  coolDown?: number; // 秒
  attr?: AttrKey;
  xp?: [number, number];
  favorNpc?: string;
  favor?: number;
  item?: string;
  itemNum?: number;
  jianwen?: string;
  jianwenName?: string;
  /** 方案2：单结算事件（无 options）也可直接给技能经验，与 attr/xp 并存（skill 字段沿用上方闸门字段） */
  skillXp?: [number, number];
  options?: EventOptionDef[];
  rarity: 0 | 1 | 2;
  logHigh?: boolean;
}

/** 物品特殊 tag：按类别随机取一件 */
const ITEM_CAT_ALIAS: Record<string, string> = { mat: '材料', rare: '稀有', craft: '成品' };

/**
 * 选项奖励预告（供 UI 在玩家选择前展示）。
 * 只用 cfg、不用 state：好感通配符不指名具体武将，物品类别不指定具体物品，
 * 与结算侧（randomItemTag / maybeFirstMeet）保持同样的不确定性。
 */
export function describeOptionRewards(cfg: GameConfig, o: {
  attr?: AttrKey; xp?: [number, number]; favorNpc?: string; favor?: number;
  item?: string; itemNum?: number; jianwen?: string; jianwenName?: string;
  skill?: string; skillXp?: [number, number]; money?: boolean;
}): string {
  const parts: string[] = [];
  const rng = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}~${r[1]}`);
  if (o.attr && o.xp) parts.push(`${ATTR_NAMES[o.attr]}经验 +${rng(o.xp)}`);
  if (o.skill && o.skillXp) {
    const nm = cfg.skillByTag[o.skill]?.name ?? o.skill;
    parts.push(`${nm}经验 +${rng(o.skillXp)}`);
  }
  if (o.favorNpc) {
    const n = o.favor ?? 5;
    if (o.favorNpc === '*') parts.push(`结识新武将`);
    else if (o.favorNpc === '?') parts.push(`随机武将好感 +${n}`);
    else {
      const g = generalByTag[o.favorNpc];
      parts.push(`${g ? g.name : o.favorNpc}好感 +${n}`);
    }
  }
  if (o.item) {
    const n = Math.max(1, o.itemNum ?? 1);
    const cat = ITEM_CAT_ALIAS[o.item];
    parts.push(cat ? `得 ${cat}物品 ×${n}` : `得 ${cfg.itemByTag[o.item]?.name ?? o.item} ×${n}`);
  }
  if (o.money) parts.push('获赏金（随进度）');
  if (o.jianwen) parts.push(`见闻「${o.jianwenName ?? o.jianwen}」`);
  return parts.join(' · ');
}

// ── 系统级提示的冷却（借 eventCooldown 存保留 key，避免每 10 分钟刷屏） ──
const SYS_CD_FULL = 'sys:containerFull';
const SYS_CD_BACKLOG = 'sys:backlog';
const SYS_NOTICE_CD_SEC = 1800; // 30 分钟

/** 发一条带冷却的系统提示；冷却中则静默。@returns 是否发出 */
function sysNotice(state: GameState, key: string, now: number, text: string): boolean {
  if ((state.eventCooldown[key] ?? 0) > now) return false;
  state.eventCooldown[key] = now + SYS_NOTICE_CD_SEC * 1000;
  emitEvent(state, text, 1, 'event');
  return true;
}

// ────────────────────────────── 内容：60 条 ──────────────────────────────

/** ① 风土见闻 14 条（时限 4h · rarity 0 · 基础权重 30） */
const JW: EventDef[] = [
  {
    tag: 'jw_jiaozhi_yiyi', type: 'jw', title: '薏苡之谤',
    text: '至{city}，见薏苡满车。乡老言：昔伏波将军载此而归，人以为明珠，遂有谤书。',
    cities: ['jiaozhi'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [3, 5], jianwen: 'jw_yiyi', jianwenName: '薏苡之谤', rarity: 0,
  },
  {
    tag: 'jw_liangzhou_dama', type: 'jw', title: '凉州大马',
    text: '过{city}，羌人牧马，马皆高大。胡商拍鞍笑曰："凉州大马，横行天下。"',
    cities: ['wuwei', 'xiping'], weightBase: 30, onceOnly: true,
    attr: 'force', xp: [3, 5], jianwen: 'jw_dama', jianwenName: '凉州大马', rarity: 0,
  },
  {
    tag: 'jw_xiangyang_caolu', type: 'jw', title: '襄阳草庐',
    text: '{city}西二十里有草庐，童子言"先生昼寝未醒"。候之不得，惟见松竹萧然。',
    cities: ['xiangyang'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [4, 6], jianwen: 'jw_caolu', jianwenName: '襄阳草庐', rarity: 0,
  },
  {
    tag: 'jw_ye_tongque', type: 'jw', title: '铜雀台',
    text: '登{city}台，匠人言此台初成时，夜有雀集其上，因以为名。',
    cities: ['ye'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [3, 5], jianwen: 'jw_tongque', jianwenName: '铜雀台', rarity: 0,
  },
  {
    tag: 'jw_luoyang_taixue', type: 'jw', title: '太学题名',
    text: '{city}太学诸生聚议朝政，有人邀你题名卷末。题则惹事，不题则失礼。',
    cities: ['luoyang'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [3, 5], jianwen: 'jw_taixue', jianwenName: '太学题名', rarity: 0,
  },
  {
    tag: 'jw_chengdu_jinguan', type: 'jw', title: '锦官织造',
    text: '{city}锦官城，机声彻夜。织工言：一匹之价，当粟十石。',
    cities: ['chengdu'], weightBase: 30, onceOnly: true,
    attr: 'intelligent', xp: [3, 5], jianwen: 'jw_jinguan', jianwenName: '锦官织造', rarity: 0,
  },
  {
    tag: 'jw_jianye_zaochuan', type: 'jw', title: '建业大舶',
    text: '{city}船坞，大舶高数丈。老匠言：此舟可载三千斛，然过险滩必轻装。',
    cities: ['jianye'], weightBase: 30, onceOnly: true,
    attr: 'intelligent', xp: [3, 5], jianwen: 'jw_zaochuan', jianwenName: '建业大舶', rarity: 0,
  },
  {
    tag: 'jw_nanhai_zhuji', type: 'jw', title: '南海珠玑',
    text: '{city}市舶，犀角象牙堆积如山。贾人言：一珠之价，可易一城之粟。',
    cities: ['nanhai'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [3, 5], jianwen: 'jw_zhuji', jianwenName: '南海珠玑', rarity: 0,
  },
  {
    tag: 'jw_changan_huaishi', type: 'jw', title: '槐市书肆',
    text: '过{city}槐市，书肆林立。有老儒抱简而泣，言西都旧事。',
    cities: ['changan'], weightBase: 30, onceOnly: true,
    attr: 'intelligent', xp: [3, 5], jianwen: 'jw_huaishi', jianwenName: '槐市书肆', rarity: 0,
  },
  {
    tag: 'jw_tianshui_tielong', type: 'jw', title: '铁笼山',
    text: '{city}铁笼山，形势险绝。戍卒言：昔有少年将军据此，以少击众。',
    cities: ['tianshui'], weightBase: 30, onceOnly: true,
    attr: 'force', xp: [3, 5], jianwen: 'jw_tielong', jianwenName: '铁笼山', rarity: 0,
  },
  {
    tag: 'jw_qiao_huayuan', type: 'jw', title: '谯郡药圃',
    text: '{city}药圃百草萋萋。圃叟言：此地出一神医，能剖腹涤肠，今不知所往。',
    cities: ['qiao'], facility: 'herb', weightBase: 30, onceOnly: true,
    attr: 'intelligent', xp: [3, 5], jianwen: 'jw_huayuan', jianwenName: '谯郡药圃', rarity: 0,
  },
  {
    tag: 'jw_henei_simashi', type: 'jw', title: '河内司马',
    text: '过{city}，乡人指一旧宅曰：司马氏故居，兄弟八人，皆一时之杰。',
    cities: ['henei'], weightBase: 30, onceOnly: true,
    attr: 'politics', xp: [4, 6], jianwen: 'jw_simashi', jianwenName: '河内司马', rarity: 0,
  },
  {
    tag: 'jw_chenliu_qibing', type: 'jw', title: '陈留起兵',
    text: '{city}城下，父老言：昔有人散家财、合义兵于此，一郡响应。',
    cities: ['chenliu'], weightBase: 30, onceOnly: true,
    attr: 'leadership', xp: [3, 5], jianwen: 'jw_qibing', jianwenName: '陈留起兵', rarity: 0,
  },
  {
    tag: 'jw_xiapi_baimen', type: 'jw', title: '白门楼',
    text: '登{city}白门楼，楼犹在而人事已非。守卒言：此楼下曾缚一虓虎。',
    cities: ['xiapi'], weightBase: 30, onceOnly: true,
    attr: 'force', xp: [3, 5], jianwen: 'jw_baimen', jianwenName: '白门楼', rarity: 0,
  },
];

/** ② 路人遭遇 12 条（时限 4h · 基础权重 20） */
const EN: EventDef[] = [
  {
    tag: 'en_horsetrader', type: 'en', title: '贩马客',
    text: '道遇贩马客，言语豪迈。临别解鞍下筋一束相赠。',
    weightBase: 20, attr: 'force', xp: [3, 5], item: 'mat', itemNum: 1, rarity: 0,
  },
  {
    tag: 'en_xia_you', type: 'en', title: '游侠之问',
    text: '一游侠横刀而过，问你："天下将乱，君欲何为？"',
    weightBase: 20, rarity: 0,
    options: [
      { text: '提剑除暴', attr: 'force', xp: [4, 6] },
      { text: '归耕读书', attr: 'politics', xp: [4, 6] },
    ],
  },
  {
    tag: 'en_refugee', type: 'en', title: '流民塞道',
    text: '流民塞道，稚子牵衣求食。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '分粮与之', attr: 'politics', xp: [5, 7] },
      { text: '呵斥使去', attr: 'leadership', xp: [2, 4] },
    ],
  },
  {
    tag: 'en_fangshi', type: 'en', title: '方士索金',
    text: '方士拦路，自言能炼不死之药，索重金。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '倾囊求药', skill: 'alchemy', skillXp: [6, 10], jianwen: 'en_dan', jianwenName: '炼丹之说' },
      { text: '笑而谢之', attr: 'intelligent', xp: [3, 5] },
    ],
  },
  {
    tag: 'en_beggar_scholar', type: 'en', title: '丐者不俗',
    text: '道旁一乞丐，衣褐百结，然言谈不俗。',
    weightBase: 12, rarity: 1,
    options: [
      { text: '倾囊相助', favorNpc: '*', favor: REL_FIRST_MEET },
      { text: '不顾而去', attr: 'leadership', xp: [1, 3] },
    ],
  },
  {
    tag: 'en_medicine_man', type: 'en', title: '走方郎中',
    text: '走方郎中与你论药，指山谷数种草木，皆非本草所载。',
    skill: 'herbalism', skillLv: 3, weightBase: 20, weightSkill: 8,
    attr: 'intelligent', xp: [4, 6], skillXp: [6, 10], rarity: 0,
  },
  {
    tag: 'en_old_soldier', type: 'en', title: '醉卧老兵',
    text: '退役老兵醉卧道旁，醒来为你演一套枪法。',
    weightBase: 20, attr: 'force', xp: [4, 6], rarity: 0,
  },
  {
    tag: 'en_hu_merchant', type: 'en', title: '胡商驼队',
    text: '胡商驱驼队而来，言语不通，以物易物。',
    cities: ['wuwei', 'xiping', 'changan'], weightBase: 20, rarity: 0,
    options: [
      { text: '以货易货', item: 'craft', itemNum: 1 },
      { text: '问西域事', skill: 'envoy', skillXp: [5, 9] },
      { text: '代传口信，受酬金', money: true },
    ],
  },
  {
    tag: 'en_boatman', type: 'en', title: '同舟共渡',
    text: '船工邀你同渡，舟中言江上风涛与沿岸豪强。',
    cities: ['jianye', 'jiangling', 'jiangxia'], weightBase: 20,
    attr: 'leadership', xp: [3, 5], rarity: 0,
  },
  {
    tag: 'en_hunter', type: 'en', title: '猎户邀猎',
    text: '猎户邀你同入围场，指一兽迹："此物夜行，不可轻追。"',
    skill: 'hunting', skillLv: 3, weightBase: 20, weightSkill: 8, rarity: 0,
    options: [
      { text: '追之', attr: 'force', xp: [5, 7] },
      { text: '止步观猎', skill: 'hunting', skillXp: [6, 10], jianwen: 'en_hunt_trace', jianwenName: '兽迹辨识' },
    ],
  },
  {
    tag: 'en_guan_npc', type: 'en', title: '绿袍长髯',
    text: '道遇一赳赳武夫，绿袍长髯，自言解人，欲与你同行一程。',
    npc: 'guanyu', weightBase: 20, weightSkill: 0,
    attr: 'force', xp: [3, 5], favorNpc: 'guanyu', favor: 6, rarity: 1,
  },
  {
    tag: 'en_zhao_npc', type: 'en', title: '白袍单骑',
    text: '一白袍将军单骑而过，见你负重，解囊相助而不留名。',
    npc: 'zhaoyun', weightBase: 20,
    attr: 'leadership', xp: [3, 5], favorNpc: 'zhaoyun', favor: 6, rarity: 1,
  },
];

/** ③ 旅途二选一 12 条（时限 4h · 基础权重 20） */
const CH: EventDef[] = [
  {
    tag: 'ch_guanroad', type: 'ch', title: '岔口之择',
    text: '岔口在前：官道多盘查而安稳；小路近半日，却传闻有匪。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '走官道', attr: 'leadership', xp: [3, 5] },
      { text: '抄小路', attr: 'force', xp: [5, 7] },
    ],
  },
  {
    tag: 'ch_ferry', type: 'ch', title: '渡与绕',
    text: '江横于前：渡船速而费钱；绕桥十里而免费。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '乘渡船', attr: 'leadership', xp: [2, 4] },
      { text: '绕桥而行', attr: 'force', xp: [3, 5], jianwen: 'ch_raoqiao', jianwenName: '绕桥十里' },
    ],
  },
  {
    tag: 'ch_help_sick', type: 'ch', title: '道旁病者',
    text: '道旁一人病卧，气息奄奄。救则误程，不救则心不安。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '出手相救', attr: 'politics', xp: [6, 8], favorNpc: '?', favor: 3 },
      { text: '继续赶路', attr: 'leadership', xp: [2, 4] },
      { text: '受其家人酬谢', money: true },
    ],
  },
  {
    tag: 'ch_shelter', type: 'ch', title: '暮色借宿',
    text: '天色将暮，前有村落可借宿，然夜行可省一日。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '借宿村中', attr: 'intelligent', xp: [3, 5] },
      { text: '趁夜疾行', attr: 'force', xp: [4, 6] },
    ],
  },
  {
    tag: 'ch_guide', type: 'ch', title: '山道向导',
    text: '山道难行，有人自荐为向导，索酬颇昂。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '雇为向导', attr: 'politics', xp: [2, 4] },
      { text: '自行探路', attr: 'intelligent', xp: [4, 6] },
    ],
  },
  {
    tag: 'ch_share_grain', type: 'ch', title: '囊中亦匮',
    text: '流民拦车求粮，你囊中亦不裕。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '分粮', attr: 'politics', xp: [5, 7] },
      { text: '自留', attr: 'leadership', xp: [2, 4] },
    ],
  },
  {
    tag: 'ch_letter', type: 'ch', title: '捎信之请',
    text: '一老妪求你捎信至邻县，绕道三十里。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '应允捎带', attr: 'politics', xp: [4, 6], jianwen: 'ch_shaoxin', jianwenName: '邻县捎信' },
      { text: '婉言谢绝', attr: 'leadership', xp: [1, 3] },
    ],
  },
  {
    tag: 'ch_detour_tomb', type: 'ch', title: '古墓旧剑',
    text: '附近有古墓，传闻藏有旧剑。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '入墓探视', attr: 'force', xp: [4, 6], item: 'mat', itemNum: 1 },
      { text: '直行不顾', attr: 'leadership', xp: [2, 4] },
    ],
  },
  {
    tag: 'ch_buy_horse', type: 'ch', title: '市有骏马',
    text: '市有骏马，价昂。买则速，不买则步。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '买马', attr: 'leadership', xp: [3, 5] },
      { text: '步行', attr: 'force', xp: [4, 6] },
    ],
  },
  {
    tag: 'ch_rain_temple', type: 'ch', title: '骤雨破庙',
    text: '骤雨将至，前有破庙可避。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '入庙避雨', attr: 'intelligent', xp: [3, 5] },
      { text: '冒雨而行', attr: 'force', xp: [3, 5] },
    ],
  },
  {
    tag: 'ch_wade', type: 'ch', title: '溪水暴涨',
    text: '溪水暴涨。涉水则速，候退则稳。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '涉水而过', attr: 'force', xp: [4, 6] },
      { text: '候水退去', attr: 'intelligent', xp: [3, 5] },
    ],
  },
  {
    tag: 'ch_inn_dispute', type: 'ch', title: '客栈争执',
    text: '夜宿客栈，邻房争执不休，似有冤情。',
    weightBase: 20, rarity: 0,
    options: [
      { text: '出面调停', attr: 'politics', xp: [5, 7] },
      { text: '闭门不问', attr: 'leadership', xp: [1, 3] },
    ],
  },
];

/** ④ 奇遇 12 条（时限 4h · 基础权重 8 · 已定：不给名品/图纸） */
const QY: EventDef[] = [
  {
    tag: 'qy_huangshigong', type: 'qy', title: '圯上授书',
    text: '夜宿破庙，一老者箕踞而坐，授书一卷，天明不知所之。',
    weightBase: 8, onceOnly: true,
    attr: 'intelligent', xp: [18, 25], item: 'rare', itemNum: 2,
    jianwen: 'qy_huangshi', jianwenName: '圯上授书', rarity: 2, logHigh: true,
  },
  {
    tag: 'qy_wolong', type: 'qy', title: '草庐昼寝',
    text: '山中有庐，童子言"先生昼寝未醒"。你候至日昃，终得一面。',
    cities: ['xiangyang'], weightBase: 8, onceOnly: true, rarity: 2, logHigh: true,
    options: [
      { text: '问天下大计', attr: 'politics', xp: [18, 22] },
      { text: '请其出山', favorNpc: 'zhugeliang', favor: 10, skill: 'visiting', skillXp: [12, 18] },
    ],
  },
  {
    tag: 'qy_shuijing', type: 'qy', title: '松下抚琴',
    text: '一隐士抚琴于松下，见你而笑："君骨相清奇，惜乎缓不济急。"',
    skill: 'visiting', skillLv: 5, weightBase: 8, weightSkill: 8, onceOnly: true,
    attr: 'politics', xp: [15, 20], skillXp: [12, 16], jianwen: 'qy_shuijing', jianwenName: '松下抚琴', rarity: 1,
  },
  {
    tag: 'qy_zuoci', type: 'qy', title: '眇目道人',
    text: '道上遇一眇目道人，以丹相赠，言"此物可解百毒"，即化去。',
    skill: 'alchemy', skillLv: 5, weightBase: 8, weightSkill: 8, onceOnly: true,
    attr: 'intelligent', xp: [15, 20], skillXp: [12, 16], rarity: 1,
  },
  {
    tag: 'qy_pickup', type: 'qy', title: '道旁遗囊',
    text: '道旁遗一囊，中有旧物与书信，字迹斑驳。',
    weightBase: 8, rarity: 1,
    options: [
      { text: '寻主归还', attr: 'politics', xp: [10, 14] },
      { text: '据为己有', item: 'craft', itemNum: 1 },
    ],
  },
  {
    tag: 'qy_hidden_craft', type: 'qy', title: '废坊遗法',
    text: '深山遇一废坊，机括犹存，老匠临终授其法。',
    skill: 'crafting', skillLv: 6, weightBase: 8, weightSkill: 8, onceOnly: true,
    attr: 'intelligent', xp: [15, 20], skillXp: [12, 16],
    jianwen: 'qy_feifang', jianwenName: '废坊遗法', rarity: 1,
  },
  {
    tag: 'qy_beast', type: 'qy', title: '异兽入谷',
    text: '逐兽入谷，得一异兽，毛色非常。',
    skill: 'hunting', skillLv: 6, weightBase: 8, weightSkill: 8, onceOnly: true, rarity: 1,
    options: [
      { text: '擒之', attr: 'force', xp: [16, 20] },
      { text: '纵之', attr: 'politics', xp: [10, 14] },
    ],
  },
  {
    tag: 'qy_old_general', type: 'qy', title: '老将三式',
    text: '校场夜遇一老将独舞大刀，见你而授三式。',
    skill: 'sworn', skillLv: 6, weightBase: 8, weightSkill: 8, onceOnly: true,
    attr: 'force', xp: [18, 25], item: 'rare', itemNum: 2,
    jianwen: 'qy_laojiang', jianwenName: '老将三式', rarity: 2, logHigh: true,
  },
  {
    tag: 'qy_envoys', type: 'qy', title: '异邦图卷',
    text: '使馆遇异邦使者，言语难通，以图卷相示。',
    cities: ['luoyang', 'xuchang', 'jianye'], facility: 'embassy',
    weightBase: 8, onceOnly: true,
    attr: 'politics', xp: [15, 20], item: 'rare', itemNum: 2,
    jianwen: 'qy_yibang', jianwenName: '异邦图卷', rarity: 2, logHigh: true,
  },
  {
    tag: 'qy_old_well', type: 'qy', title: '枯井涌泉',
    text: '村中枯井忽涌清泉，众以为瑞。',
    weightBase: 8, onceOnly: true,
    attr: 'politics', xp: [10, 14], jianwen: 'qy_kujing', jianwenName: '枯井涌泉', rarity: 1,
  },
  {
    tag: 'qy_star', type: 'qy', title: '客星犯紫微',
    text: '夜观星象，有客星犯紫微。老者言：天下将有大变。',
    skill: 'visiting', skillLv: 4, weightBase: 8, weightSkill: 8, skillXp: [10, 14], onceOnly: true,
    attr: 'intelligent', xp: [12, 16], jianwen: 'qy_kexing', jianwenName: '客星犯紫微', rarity: 1,
  },
  {
    tag: 'qy_sworn', type: 'qy', title: '焚香结拜',
    text: '校场遇数人焚香结拜，邀你共饮。',
    cities: ['ji', 'puyang', 'xiapi'], facility: 'ground', weightBase: 8, rarity: 1,
    options: [
      { text: '歃血为盟', favorNpc: '*', favor: REL_FIRST_MEET, skill: 'sworn', skillXp: [10, 16] },
      { text: '旁观而已', attr: 'leadership', xp: [6, 10] },
    ],
  },
];

/** ⑤ 地盘事件 10 条（时限 4h · 基础权重 22） */
const DP: EventDef[] = [
  {
    tag: 'dp_smith_duel', type: 'dp', title: '铁匠铺较艺',
    text: '铁匠铺老匠见你所佩兵器，嗤曰："此亦可谓兵？"邀你共锻一器。',
    facility: 'smith', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '应战共锻', attr: 'force', xp: [6, 10], item: 'craft', itemNum: 1 },
      { text: '虚心求教', skill: 'smithing', skillXp: [8,12] },
      { text: '受老匠赠银', money: true },
    ],
  },
  {
    tag: 'dp_alchemy_fang', type: 'dp', title: '丹房参方',
    text: '丹房炉火正红，方士邀你共参一丹方。',
    facility: 'alchemy', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '守其火候', attr: 'intelligent', xp: [6, 10] },
      { text: '论其药性', skill: 'alchemy', skillXp: [8, 12] },
    ],
  },
  {
    tag: 'dp_workshop', type: 'dp', title: '机巧坊机括',
    text: '机巧坊中木牛流马之属，散件满地，匠正苦其机括。',
    facility: 'workshop', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '助其成器', attr: 'intelligent', xp: [7, 11] },
      { text: '默记其法', skill: 'crafting', skillXp: [8, 12] },
    ],
  },
  {
    tag: 'dp_temple_lun', type: 'dp', title: '道观论道',
    text: '道观钟磬，道士邀你论道。问：何为"无为"？',
    facility: 'temple', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '论其道妙', skill: 'visiting', skillXp: [8, 12] },
      { text: '无为者，不扰其民', attr: 'politics', xp: [6, 10] },
      { text: '无为者，静以待时', attr: 'leadership', xp: [6, 10] },
    ],
  },
  {
    tag: 'dp_ground_bi', type: 'dp', title: '校场比试',
    text: '校场有少年邀你比试，输者请酒。',
    facility: 'ground', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '与之比试', attr: 'force', xp: [6, 10] },
      { text: '逊让不较', attr: 'politics', xp: [5, 8] },
    ],
  },
  {
    tag: 'dp_embassy', type: 'dp', title: '使馆代译',
    text: '使馆正译异邦文书，译者病，邀你相助。',
    facility: 'embassy', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '代为移译', skill: 'envoy', skillXp: [8, 12] },
      { text: '荐举他人', attr: 'politics', xp: [5, 8], favorNpc: '?', favor: 3 },
      { text: '受使馆之赏', money: true },
    ],
  },
  {
    tag: 'dp_mine_vein', type: 'dp', title: '矿脉将尽',
    text: '矿脉将尽，矿工议弃坑。老矿工言：深处或有异铁。',
    facility: 'mine', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '深掘求铁', attr: 'force', xp: [5, 9] },
      { text: '另寻新脉', skill: 'mining', skillXp: [8, 12] },
    ],
  },
  {
    tag: 'dp_herb_plague', type: 'dp', title: '药圃有疫',
    text: '药圃附近有疫，圃叟束手，求你入山采药。',
    facility: 'herb', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '入山采药', skill: 'herbalism', skillXp: [8, 12] },
      { text: '施粥安民', attr: 'politics', xp: [6, 9] },
    ],
  },
  {
    tag: 'dp_hunt_beast', type: 'dp', title: '猎场猛兽',
    text: '猎场猛兽伤人，猎户请除之。',
    facility: 'hunt', weightBase: 22, weightSkill: 8, rarity: 0,
    options: [
      { text: '往除其患', attr: 'force', xp: [7, 11] },
      { text: '设阱以擒', skill: 'hunting', skillXp: [8, 12] },
    ],
  },
  {
    tag: 'dp_tavern_hear', type: 'dp', title: '酒肆论英雄',
    text: '酒肆中人声嘈杂，邻座数人正论天下英雄。',
    facility: 'tavern', weightBase: 22, rarity: 0,
    options: [
      { text: '论其用人', attr: 'politics', xp: [4, 8], jianwen: 'dp_yingxiong', jianwenName: '酒肆论英雄' },
      { text: '论其用兵', attr: 'leadership', xp: [4, 8] },
      { text: '论其成败', attr: 'intelligent', xp: [4, 8] },
      { text: '受座中客宴请之资', money: true },
    ],
  },
];

export const EVENT_DEFS: EventDef[] = [...JW, ...EN, ...CH, ...QY, ...DP];

export const eventByTag: Record<string, EventDef> = Object.fromEntries(
  EVENT_DEFS.map((e) => [e.tag, e]),
);

/** 见闻条目字典（tag → 名称），供收集清单展示 */
export const JIANWEN_NAMES: Record<string, string> = Object.fromEntries(
  EVENT_DEFS.filter((e) => e.jianwen && e.jianwenName).map((e) => [e.jianwen as string, e.jianwenName as string]),
);

// ────────────────────────────── 容器与触发 ──────────────────────────────

/** 读档兜底：补齐随机事件相关字段（同版本号但字段缺失的旧存档） */
export function ensureEventFields(state: GameState): void {
  if (!Array.isArray(state.pending)) state.pending = [];
  if (typeof state.nextEventId !== 'number') state.nextEventId = state.pending.length + 1;
  if (typeof state.eventPoints !== 'number') state.eventPoints = 0;
  if (typeof state.nextEventGap !== 'number') state.nextEventGap = EVENT_POINT_SEC;
  if (typeof state.eventToday !== 'number') state.eventToday = 0;
  if (typeof state.eventDay !== 'string') state.eventDay = '';
  if (!Array.isArray(state.jianwen)) state.jianwen = [];
  if (!Array.isArray(state.visitedCities)) state.visitedCities = [];
  if (!Array.isArray(state.visitedFacilities)) state.visitedFacilities = [];
  if (!state.eventCooldown || typeof state.eventCooldown !== 'object') state.eventCooldown = {};
  if (!Array.isArray(state.doneEvents)) state.doneEvents = [];
}

export interface TriggerCtx {
  cfg: GameConfig;
  cityTag?: string;
  facility?: string;
}

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 条件筛选（标签闸门） */
function matchCond(state: GameState, def: EventDef, ctx: TriggerCtx, now: number): boolean {
  if (def.onceOnly && state.doneEvents.includes(def.tag)) return false;
  if ((state.eventCooldown[def.tag] ?? 0) > now) return false;
  if (def.cities && def.cities.length) {
    if (!ctx.cityTag || !def.cities.includes(ctx.cityTag)) return false;
  }
  if (def.facility && ctx.facility !== def.facility) return false;
  if (def.npc && (state.relations[def.npc] ?? 0) <= 0) return false; // 需已结识
  if (def.skill) {
    const lv = state.skills[def.skill]?.lv ?? 0;
    if (lv < (def.skillLv ?? 1)) return false;
  }
  return true;
}

/** 属性补偿（F19c）：落后于自身均值过多的属性，对应事件加权 */
function laggingAttrs(state: GameState): Set<AttrKey> {
  const keys: AttrKey[] = ['force', 'leadership', 'intelligent', 'politics'];
  const avg = keys.reduce((a, k) => a + (state.attrs[k] ?? 0), 0) / keys.length;
  const out = new Set<AttrKey>();
  for (const k of keys) if ((state.attrs[k] ?? 0) < avg - 2) out.add(k);
  return out;
}

/** 加权抽取：基础权重 + 技能(Q11) + 人物好感 + 属性补偿 */
function weightedPick(state: GameState, pool: EventDef[], lag: Set<AttrKey>): EventDef | null {
  const weights = pool.map((d) => {
    let w = d.weightBase;
    if (d.skill) w += d.weightSkill ?? 8; // Q11：技能命中 → 提高该向事件权重
    if (d.npc) w += Math.min(10, (state.relations[d.npc] ?? 0) / 10); // 好感越高越容易遇到
    if (d.attr && lag.has(d.attr)) w += 5;
    return Math.max(1, w);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let x = randFloat(state) * total;
  for (let i = 0; i < pool.length; i++) {
    x -= weights[i];
    if (x <= 0) return pool[i];
  }
  return pool[pool.length - 1] ?? null;
}

/** 触发一次机会（容器满 / 达每日上限 → 不生成；压力落在"在线不处理"） */
export function tryTriggerEvent(state: GameState, ctx: TriggerCtx): boolean {
  const now = state.simNow;
  const day = dayKey(now);
  if (state.eventDay !== day) {
    state.eventDay = day;
    state.eventToday = 0;
  }
  if (state.eventToday >= EVENT_DAILY_CAP) return false;
  if (state.pending.length >= EVENT_CONTAINER_CAP) {
    // 容器满：明示"错过了一条"（只失去这次机会，不倒扣）。带冷却，避免每 10 分钟刷屏。
    if (sysNotice(state, SYS_CD_FULL, now, '事件列表已满，新事件未能出现（先处理掉几条）')) return false;
    return false;
  }

  const pool = EVENT_DEFS.filter((d) => matchCond(state, d, ctx, now));
  if (!pool.length) return false;
  const picked = weightedPick(state, pool, laggingAttrs(state));
  if (!picked) return false;

  const cityName = ctx.cityTag ? ctx.cfg.cityByTag[ctx.cityTag]?.name ?? ctx.cityTag : '';
  state.pending.push({
    id: state.nextEventId++,
    tag: picked.tag,
    at: now,
    expireAt: now + EVENT_TTL_SEC,
    cityName,
  });
  state.eventToday += 1;

  // 触发提示分级：普通只入列表（不打扰）；稀有提示；传说强调
  const where = cityName ? `于${cityName}` : '';
  if (picked.rarity >= 2) {
    emitEvent(state, `奇遇！${picked.title}${where}（限时 4 小时）`, 2, 'event');
  } else if (picked.rarity >= 1) {
    emitEvent(state, `有事件待处理：${picked.title}${where}`, 1, 'event');
  } else {
    emitEvent(state, `有事件待处理：${picked.title}${where}`, 0, 'event');
  }

  // 积压预警：容器接近硬上限时提醒（压力落在"在线不处理"）。同样带冷却。
  if (state.pending.length >= EVENT_CONTAINER_CAP - 5) {
    sysNotice(state, SYS_CD_BACKLOG, now, `事件已积压 ${state.pending.length} 条，及时处理以免错失`);
  }
  // 当日上限首次达成
  if (state.eventToday === EVENT_DAILY_CAP) {
    emitEvent(state, '今日事件已到上限，明日再来', 0, 'event');
  }
  return true;
}

/**
 * 时间源：仅「赶路(moving)」阶段累积（调用方已用 `phase.kind==='moving'` 把关；离线冻结）。
 * 每次触发后把下一次目标间隔 `nextEventGap` 在 [EVENT_GAP_MIN, EVENT_GAP_MAX] 间均匀随机重摇，
 * 期望 = (300+900)/2 = 600s = 10 分钟——节奏有波动，不再机械卡每 10 分钟整点。
 */
export function advanceEventClock(state: GameState, cfg: GameConfig, dt: number): void {
  if (!(dt > 0)) return;
  state.eventPoints += dt;
  let guard = 0;
  while (state.eventPoints >= state.nextEventGap && guard++ < 100) {
    state.eventPoints -= state.nextEventGap;
    tryTriggerEvent(state, { cfg });
    // 重摇下一次间隔：均匀随机 5~15 分钟，期望 10 分钟
    state.nextEventGap = randInt(state, EVENT_GAP_MIN, EVENT_GAP_MAX);
  }
}

/**
 * 过期：只失去"这次机会"，明示，不倒扣任何资产。
 * 保底：待处理数已 ≤ EVENT_KEEP_MIN 时，即使超时也**不再丢弃**（倒序遍历，从最新往旧扫，
 * 一旦剩到保底数即停止），因此离线再久回来也至少能看到/处理 EVENT_KEEP_MIN 条。
 * 仅当待处理数 > EVENT_KEEP_MIN 时，超时的旧事件才会被清掉。
 */
export function expireEvents(state: GameState): void {
  const now = state.simNow;
  for (let i = state.pending.length - 1; i >= 0; i--) {
    if (state.pending[i].expireAt > now) continue;
    // 保底：已 ≤ EVENT_KEEP_MIN 条则停止丢弃，最近的 N 条（含已超时但被保底的）全部保留
    if (state.pending.length <= EVENT_KEEP_MIN) break;
    const def = eventByTag[state.pending[i].tag];
    emitEvent(state, `错过了「${def?.title ?? '事件'}」（未倒扣任何所得）`, 0, 'event');
    state.pending.splice(i, 1);
  }
}

// ────────────────────────────── 结算 ──────────────────────────────

function randomItemTag(state: GameState, cfg: GameConfig, aliasOrTag: string): string {
  const cat = ITEM_CAT_ALIAS[aliasOrTag];
  if (!cat) return aliasOrTag;
  let pool = cfg.items.filter((it) => it.cat === cat);
  // 红线延伸：图纸是制造解锁门槛，事件赠礼不得绕过它。
  // 成品只从「已解锁」的里面给（q1-3 天生会 + 已持有对应图纸），否则玩家没图就白拿神兵，解锁节奏失效。
  if (cat === '成品') {
    const owned = new Set(state.blueprints);
    const ok = pool.filter((it) => {
      const r = cfg.recipeByResult[it.tag];
      return !r || !r.needBlueprint || owned.has(r.needBlueprint);
    });
    if (ok.length) pool = ok;
  }
  const hit = pickOne(state, pool);
  return hit?.tag ?? aliasOrTag;
}

interface RewardView {
  attr?: AttrKey;
  xp?: [number, number];
  favorNpc?: string;
  favor?: number;
  item?: string;
  itemNum?: number;
  jianwen?: string;
  jianwenName?: string;
  skill?: string;
  skillXp?: [number, number];
  money?: boolean;
}

function applyFavor(state: GameState, who: string, amount: number): string {
  if (who === '*') {
    // 随机素未谋面者 → 走初识
    const tag = maybeFirstMeet(state);
    if (tag) return `与${generalByTag[tag]?.name ?? tag}初识`;
    return '';
  }
  if (who === '?') {
    const met = GENERALS.filter((g) => (state.relations[g.tag] ?? 0) > 0);
    const g = pickOne(state, met);
    if (!g) return '';
    state.relations[g.tag] = (state.relations[g.tag] ?? 0) + amount;
    return `${g.name}好感 +${amount}`;
  }
  const g = generalByTag[who];
  if (!g) return '';
  const cur = state.relations[g.tag] ?? 0;
  if (cur <= 0) {
    // 关系 0 → 视为初识
    state.relations[g.tag] = REL_FIRST_MEET + amount;
    emitEvent(state, `初识${g.faction}${g.name}`, 1, 'meet');
    return `初识${g.name}`;
  }
  state.relations[g.tag] = cur + amount;
  return `${g.name}好感 +${amount}`;
}

/** 一条奖励明细（供结果面板 / 飘字展示） */
export interface RewardLine {
  icon: string;
  text: string;
}

/** 单次事件造成的属性经验变化快照（供奖励浮层播放经验条增长动画） */
export interface AttrGainInfo {
  key: AttrKey;
  beforeLv: number;
  beforeXp: number;
  afterLv: number;
  afterXp: number;
  gained: number;
}

/** 单次事件造成的技能经验变化快照（供结果卡播放技能经验条增长动画） */
export interface SkillGainInfo {
  tag: string;
  name: string;
  beforeLv: number;
  beforeXp: number;
  afterLv: number;
  afterXp: number;
  gained: number;
}

/** 事件处理结果：UI 用它渲染"结果卡"与飘字 */
export interface EventResult {
  eventTag: string;
  title: string;
  optionText?: string;
  lines: RewardLine[];
  rarity: 0 | 1 | 2;
  at: number;
  /** 属性经验变化（若有），用于奖励浮层播放经验条增长动画；无属性奖励则为 null */
  attrGain?: AttrGainInfo | null;
  /** 技能经验变化（若有，方案2），用于奖励浮层播放技能经验条增长动画；无技能奖励则为 null */
  skillGain?: SkillGainInfo | null;
}

/**
 * 处理一条待处理事件。
 * @param optionIndex 选项下标；`options` 为空时忽略。
 * 结算顺序：属性经验 → 事迹传播（以 attr 为展示属性）→ 好感 → 物品 → 见闻 → 事件流
 * @returns 结果明细（供 UI 立即反馈）；事件不存在时返回 null
 */
export function resolveEvent(
  state: GameState,
  cfg: GameConfig,
  id: number,
  optionIndex?: number,
): EventResult | null {
  const idx = state.pending.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const pe = state.pending[idx];
  const def = eventByTag[pe.tag];
  state.pending.splice(idx, 1);
  if (!def) return null;
  state.stats.eventsSettled = (state.stats.eventsSettled ?? 0) + 1;

  const now = state.simNow;
  if (def.onceOnly && !state.doneEvents.includes(def.tag)) state.doneEvents.push(def.tag);
  if (def.coolDown) state.eventCooldown[def.tag] = now + def.coolDown * 1000;

  const opt = def.options && optionIndex != null ? def.options[optionIndex] : undefined;
  const rw: RewardView = opt
    ? {
        attr: opt.attr, xp: opt.xp, favorNpc: opt.favorNpc, favor: opt.favor,
        item: opt.item, itemNum: opt.itemNum, jianwen: opt.jianwen, jianwenName: opt.jianwenName,
        skill: opt.skill, skillXp: opt.skillXp, money: opt.money,
      }
    : {
        attr: def.attr, xp: def.xp, favorNpc: def.favorNpc, favor: def.favor,
        item: def.item, itemNum: def.itemNum, jianwen: def.jianwen, jianwenName: def.jianwenName,
        skill: def.skill, skillXp: def.skillXp, money: undefined,
      };

  const lines: RewardLine[] = [];
  let attrGain: AttrGainInfo | null = null;
  let skillGain: SkillGainInfo | null = null;

  // ① 属性经验（与任务侧并存，不切换来源）
  if (rw.attr && rw.xp) {
    const amount = randInt(state, rw.xp[0], rw.xp[1]);
    // 记录处理前后的等级/经验快照，供奖励浮层播放经验条增长动画
    const beforeLv = state.attrs[rw.attr];
    const beforeXp = state.attrXp[rw.attr];
    addAttrXp(state, cfg, rw.attr, amount);
    attrGain = {
      key: rw.attr,
      beforeLv,
      beforeXp,
      afterLv: state.attrs[rw.attr],
      afterXp: state.attrXp[rw.attr],
      gained: amount,
    };
    // ② 事迹传播：以本次展示属性一对多涨相关武将好感
    propagateDeedAttrs(state, new Set([rw.attr]));
    // 给的是"经验"不是等级，写清楚避免玩家看到等级没动以为没给
    lines.push({ icon: '↑', text: `${ATTR_NAMES[rw.attr]}经验 +${amount}` });
  } else if (rw.attr) {
    propagateDeedAttrs(state, new Set([rw.attr]));
  }

  // ①-b 技能经验（方案2：与属性经验并列的第二成长轴；复用任务侧 addSkillXp，同一条升级曲线）
  if (rw.skill && rw.skillXp && state.skills[rw.skill]) {
    const amount = randInt(state, rw.skillXp[0], rw.skillXp[1]);
    const sp = state.skills[rw.skill];
    const nm = cfg.skillByTag[rw.skill]?.name ?? rw.skill;
    const beforeLv = sp.lv;
    const beforeXp = sp.xp;
    addSkillXp(state, cfg, rw.skill, amount);
    skillGain = { tag: rw.skill, name: nm, beforeLv, beforeXp, afterLv: sp.lv, afterXp: sp.xp, gained: amount };
    lines.push({ icon: '技', text: `${nm}经验 +${amount}` });
  }

  // ③ 好感（含初识）
  if (rw.favorNpc) {
    const t = applyFavor(state, rw.favorNpc, rw.favor ?? 5);
    if (t) lines.push({ icon: '缘', text: t });
  }

  // ④ 物品
  if (rw.item) {
    const n = Math.max(1, rw.itemNum ?? 1);
    const tag = randomItemTag(state, cfg, rw.item);
    addItem(state, tag, n);
    lines.push({ icon: '物', text: `得 ${cfg.itemByTag[tag]?.name ?? tag} ×${n}` });
  }

  // ④-b 赏金（E0b）：仅部分事件带钱选项；同一事件至多一个 money 选项（选钱 = 放弃属性/物品/好感，红线⑤ 附则）。
  // 金额随玩家档位自动放大（早期小、晚期大），全周期成立。
  if (rw.money) {
    let tier = 1;
    for (const s of Object.values(state.skills)) tier = Math.max(tier, skillTier(s.lv));
    tier = Math.max(1, Math.min(9, tier));
    const amount = Math.round(tierPrice(cfg, tier) * BOUNTY_MULT);
    if (amount > 0) {
      state.money += amount;
      state.stats.moneyEarned += amount;
      state.stats.moneyEarnedBounty += amount;
      lines.push({ icon: '金', text: `赏金 +${amount} 文` });
    }
  }

  // ⑤ 见闻（最小形态：只记录 + 归档，不做图鉴/解锁）
  if (rw.jianwen && !state.jianwen.includes(rw.jianwen)) {
    state.jianwen.push(rw.jianwen);
    lines.push({ icon: '闻', text: `见闻「${rw.jianwenName ?? rw.jianwen}」` });
  }

  if (!lines.length) lines.push({ icon: '·', text: '略有所得' });

  // ⑥ 归档（事件流留明细，便于事后追溯）
  const summary = lines.map((l) => l.text).join(' · ');
  emitEvent(state, `【${def.title}】${summary}`, def.rarity, 'event');

  return {
    eventTag: def.tag,
    title: def.title,
    optionText: opt?.text,
    lines,
    rarity: def.rarity,
    at: Date.now(),
    attrGain,
    skillGain,
  };
}
