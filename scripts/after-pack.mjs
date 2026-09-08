/**
 * electron-builder afterPack 钩子(技术手册 §10 瘦身):裁剪 Electron 自带 locales。
 * Electron dist 默认打包 ~50+ 个 .pak(每语言一个);本工具 UI 仅中英(§CLAUDE.md 语言),
 * 裁到保留集即可省下约 3~4MB(装后),不动功能。§10 明列"保留 zh-CN/en"。
 * - icudtl.dat / chrome_*.pak / resources.pak / snapshot_blob.bin / v8_context_snapshot.bin 等运行必需,一律保留;
 * - 仅删 locales/*.pak 中不在保留名单者;en-GB 归入 en 族(拼写变体),保留无害但非必需 → 一并裁。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** 保留的 locale pak 文件名(§10:zh-CN / en) */
const KEEP = new Set(['en-US.pak', 'zh-CN.pak']);

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales');
  let entries;
  try {
    entries = await fs.readdir(localesDir);
  } catch {
    return; // 无 locales 目录(异常打包形态):静默跳过,勿让瘦身失败阻断出包
  }
  let removed = 0;
  for (const f of entries) {
    if (!f.endsWith('.pak') || KEEP.has(f)) continue;
    await fs.rm(path.join(localesDir, f), { force: true });
    removed++;
  }
  console.log(`[after-pack] locales 裁剪:删 ${removed} 个 .pak,保留 {${[...KEEP].join(', ')}}(§10 瘦身)`);
}
