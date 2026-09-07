/** 架构铁律静态守卫(技术手册 §4):core/ 禁止 import electron——壳与逻辑分离是可测试的唯一保障 */
import * as fs from 'node:fs';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_DIR = url.fileURLToPath(new URL('../src/main/core', import.meta.url));

describe('core/ 隔离铁律', () => {
  it('无任何文件 import/require electron', () => {
    const files = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(7); // paths/junction/env/download/catalog/install/history/store/errors
    for (const f of files) {
      const src = fs.readFileSync(path0(CORE_DIR, f), 'utf8');
      expect(src, `${f} 引入了 electron`).not.toMatch(/from\s+['"]electron(\s|\/|['"])/);
      expect(src, `${f} 引入了 electron`).not.toMatch(/require\(\s*['"]electron/);
    }
  });
  it('core/ 不依赖 DOM/浏览器全局(纯 Node 环境可测)', () => {
    for (const f of fs.readdirSync(CORE_DIR).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path0(CORE_DIR, f), 'utf8');
      expect(src, `${f} 使用了 window`).not.toMatch(/\bwindow\./);
      expect(src, `${f} 使用了 document`).not.toMatch(/\bdocument\./);
    }
  });
});

function path0(dir: string, file: string): string {
  return dir.replace(/[\\/]$/, '') + '/' + file;
}
