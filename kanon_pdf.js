// 観音新町運動広場の「月間予定表」PDF(日付×面A〜D×時間のガント表)を読み取り、
// 日付ごと・面ごとの空き時間帯を返す。
//
// 方式: PDFのテキスト座標から「日時/面」列と時間ヘッダーの位置を割り出し、
// ページを画像化して各マスの色を判定する(白=空き / 黄・緑・ピンク=予約済み・休場)。
// PDFの様式が変わると読み取れなくなるため、失敗時は呼び出し側で握りつぶす前提。

const SCALE = 1.6;
const HOUR_FIRST = 9;
const HOUR_LAST = 20; // 20 の列 = 20:00-21:00

async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

function isWhite(r, g, b) {
  return r > 238 && g > 238 && b > 238;
}

// 中心付近 3x3 の中央値色
function sampleColor(img, x, y) {
  const rs = [], gs = [], bs = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      rs.push(img.data[i]); gs.push(img.data[i + 1]); bs.push(img.data[i + 2]);
    }
  }
  const med = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return [med(rs), med(gs), med(bs)];
}

function mergeHours(freeHours) {
  const ranges = [];
  for (const h of [...freeHours].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && last.to === h) last.to = h + 1;
    else ranges.push({ from: h, to: h + 1 });
  }
  return ranges.map((r) => `${String(r.from).padStart(2, "0")}:00-${String(r.to).padStart(2, "0")}:00`);
}

// startYear/startMonth: 1ページ目の年月。ページ順に1か月ずつ進む。
// 戻り値: { "YYYY-MM-DD": { A: ["09:00-12:00", ...], B: [...], C: [...], D: [...] } }
async function parseKanonPdf(buffer, startYear, startMonth) {
  const pdfjs = await loadPdfjs();
  const { createCanvas } = require("@napi-rs/canvas");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const result = {};

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const tc = await page.getTextContent();
    const items = tc.items
      .map((it) => {
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return { s: it.str.trim(), x: x + (it.width * SCALE) / 2, y };
      })
      .filter((it) => it.s !== "");

    const monthIdx = (startMonth - 1) + (p - 1);
    const year = startYear + Math.floor(monthIdx / 12);
    const month = (monthIdx % 12) + 1;

    // ブロック(1ページに3つの表)の原点: 見出し「日時」
    const heads = items.filter((it) => it.s === "日時").sort((a, b) => a.x - b.x);
    if (heads.length === 0) throw new Error(`page ${p}: 見出し「日時」が見つかりません`);

    for (let bi = 0; bi < heads.length; bi++) {
      const head = heads[bi];
      const xMin = head.x - 30;
      const xMax = bi + 1 < heads.length ? heads[bi + 1].x - 30 : Infinity;
      const inBlock = (it) => it.x >= xMin && it.x < xMax;

      const faceHead = items.find((it) => it.s === "面" && inBlock(it) && Math.abs(it.y - head.y) < 6);
      if (!faceHead) throw new Error(`page ${p} block ${bi}: 見出し「面」が見つかりません`);

      // 時間ヘッダー(9〜20)
      const hourCenters = {};
      for (const it of items) {
        if (!inBlock(it) || Math.abs(it.y - head.y) > 6) continue;
        const n = Number(it.s);
        if (Number.isInteger(n) && n >= HOUR_FIRST && n <= HOUR_LAST) hourCenters[n] = it.x;
      }
      const hours = Object.keys(hourCenters).map(Number).sort((a, b) => a - b);
      if (hours.length < 10) throw new Error(`page ${p} block ${bi}: 時間ヘッダーを読み取れません`);
      const cellW = (hourCenters[hours[hours.length - 1]] - hourCenters[hours[0]]) / (hours[hours.length - 1] - hours[0]);

      // 面 A〜D (面見出しと同じ列)
      const courts = items
        .filter((it) => inBlock(it) && Math.abs(it.x - faceHead.x) < 6 && /^[A-D]$/.test(it.s) && it.y > head.y + 4)
        .sort((a, b) => a.y - b.y);
      // 日付 (日時見出しと同じ列)
      const dayNums = items
        .filter((it) => inBlock(it) && Math.abs(it.x - head.x) < 6 && /^\d{1,2}$/.test(it.s) && it.y > head.y + 4)
        .sort((a, b) => a.y - b.y);

      for (const dn of dayNums) {
        const day = Number(dn.s);
        // この日付に最も近い4行(A〜D)を、y が近い順に取り出す
        const rows = courts
          .map((c) => ({ c, d: Math.abs(c.y - dn.y) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 4)
          .map((r) => r.c)
          .sort((a, b) => a.y - b.y);
        if (rows.length < 4) continue;

        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const perCourt = {};
        for (const row of rows) {
          const sampleY = row.y - 3; // ベースラインから行の中心へ補正
          const freeHours = [];
          for (const h of hours) {
            const cx = hourCenters[h];
            const left = sampleColor(img, cx - cellW * 0.25, sampleY);
            const right = sampleColor(img, cx + cellW * 0.25, sampleY);
            if (isWhite(...left) && isWhite(...right)) freeHours.push(h);
          }
          perCourt[row.s] = mergeHours(freeHours);
        }
        result[dateStr] = perCourt;
      }
    }
  }
  return result;
}

module.exports = { parseKanonPdf };
