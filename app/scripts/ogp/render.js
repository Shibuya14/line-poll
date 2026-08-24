// OGPカード画像(public/ogp3.jpg)を ogp3.html から生成するスクリプト。
// デザインを直すときは ogp3.html を編集してこれを再実行してください。
//
// 実行: npm i -D playwright && node scripts/ogp/render.js
// 依存: playwright, python3 + Pillow (JPEG圧縮用。 pip install Pillow --break-system-packages)
// Chromiumのバージョンが合わずに落ちる場合は PW_CHROMIUM_PATH=/path/to/chromium で指定可能
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'ogp3.html');
const PNG_TMP = path.join(__dirname, '_ogp3_tmp.png');
const OUT_JPG = path.join(__dirname, '..', '..', 'public', 'ogp3.jpg');

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
);
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
await page.goto('file://' + HTML);
await page.screenshot({ path: PNG_TMP });
await browser.close();

// PNG(可逆・重い) -> JPEG(高品質・軽量) に変換してpublic/に配置。
// グラデーション背景主体の画像なのでJPEGでも劣化はほぼ視認できない。
execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open("${PNG_TMP}").convert("RGB")
im.save("${OUT_JPG}", quality=92, optimize=True)
`]);

unlinkSync(PNG_TMP);
console.log('wrote', OUT_JPG);
