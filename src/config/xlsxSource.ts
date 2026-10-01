import * as XLSX from 'xlsx';

export type CellVal = string | number | boolean | null;

export interface SheetLike {
  name: string;
  rows: CellVal[][];
}

/**
 * Excel → 二维数组。浏览器与 Node 通用（tools/check.ts 也用它）。
 * 只做「读出来」，解析规则（$ 表 / 表头 / 空行）在 parse.ts 里实现。
 */
export function readXlsx(data: ArrayBuffer | Uint8Array): SheetLike[] {
  const wb = XLSX.read(data, { type: 'array' });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<CellVal[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    return { name, rows: rows as CellVal[][] };
  });
}
