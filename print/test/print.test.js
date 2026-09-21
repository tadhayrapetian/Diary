/* Отпечаток — tests for the arithmetic.
 *
 * The drawing has to be looked at, but the sizes do not: a Polaroid window is
 * 79 × 79 mm or it is not, and four of them fit on A4 or they do not. Those are
 * the parts that decide whether the paper comes out right, so they are the parts
 * that are checked here. The modules are plain browser scripts hanging off a
 * global, so they are loaded into a throwaway context rather than imported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', 'js', 'core');

const sandbox = { window: {}, console, Blob, Uint8Array, Math, Date, JSON };
vm.createContext(sandbox);
for (const file of ['units.js', 'formats.js', 'layout.js', 'pdf.js']) {
  vm.runInContext(readFileSync(join(core, file), 'utf8'), sandbox, { filename: file });
}
const PP = sandbox.window.PP;

/** A card the way the document builds one, with only what these parts read. */
function item(overrides = {}) {
  return {
    id: overrides.id || 'it-1',
    photoId: 'ph-1',
    copies: 1,
    formatId: 'pol-600',
    custom: { w: 100, h: 150 },
    orient: 'portrait',
    frame: { style: 'classic', side: null, bottom: null, border: 6 },
    ...overrides,
  };
}

function doc(items, page = {}) {
  return {
    items,
    photos: [],
    page: {
      paperId: 'a4',
      paperCustom: { w: 210, h: 297 },
      orient: 'portrait',
      margin: 6,
      borderless: false,
      gap: 4,
      mode: 'grid',
      align: 'center',
      autoRotate: false,
      contactCols: 5,
      fillCount: 0,
      ...page,
    },
    output: { dpi: 300 },
  };
}

/* ------------------------------------------------------------------- units */

test('миллиметры и пиксели ходят туда и обратно', () => {
  assert.equal(PP.units.mmToPx(25.4, 300), 300);
  assert.equal(PP.units.round(PP.units.pxToMm(300, 300), 3), 25.4);
  assert.equal(PP.units.round(PP.units.inchToMm(4), 2), 101.6);
});

test('разрешение печати считается от размера на бумаге', () => {
  // 1200 пикселей на 101.6 мм (4 дюйма) — ровно 300 dpi.
  assert.equal(Math.round(PP.units.effectiveDpi(1200, 101.6)), 300);
  assert.equal(PP.units.dpiVerdict(300), 'good');
  assert.equal(PP.units.dpiVerdict(200), 'fair');
  assert.equal(PP.units.dpiVerdict(130), 'poor');
  assert.equal(PP.units.dpiVerdict(90), 'bad');
});

test('склонения русские, а не машинные', () => {
  assert.equal(PP.units.plural(1, 'лист', 'листа', 'листов'), 'лист');
  assert.equal(PP.units.plural(3, 'лист', 'листа', 'листов'), 'листа');
  assert.equal(PP.units.plural(11, 'лист', 'листа', 'листов'), 'листов');
  assert.equal(PP.units.plural(22, 'лист', 'листа', 'листов'), 'листа');
});

/* ----------------------------------------------------------------- formats */

test('у полароида 600 карточка 88 × 107 и окно 79 × 79', () => {
  const card = PP.formats.cardSize(item());
  assert.equal(card.w, 88);
  assert.equal(card.h, 107);

  const win = PP.formats.windowRect(item());
  assert.equal(PP.units.round(win.w, 2), 79);
  assert.equal(PP.units.round(win.h, 2), 79);
  assert.equal(win.x, 4.5);
  assert.equal(win.y, 4.5);
});

test('у instax mini окно 46 × 62, а у Spectra — 91 × 73', () => {
  const mini = PP.formats.windowRect(item({ formatId: 'instax-mini' }));
  assert.equal(PP.units.round(mini.w, 2), 46);
  assert.equal(PP.units.round(mini.h, 2), 62);

  const spectra = PP.formats.windowRect(item({ formatId: 'pol-spectra' }));
  assert.equal(PP.units.round(spectra.w, 2), 91);
  assert.equal(PP.units.round(spectra.h, 2), 73);
});

test('положенный набок полароид берёт пропорции, а не размеры плёнки', () => {
  const sideways = PP.formats.windowRect(item({ orient: 'landscape' }));
  assert.equal(sideways.card.w, 107);
  assert.equal(sideways.card.h, 88);
  // Поля больше не 4.5 — иначе окно уехало бы за край.
  assert.ok(sideways.x > 5);
  assert.ok(sideways.w < 107);
  assert.ok(sideways.h > 0);
});

test('полароидная рамка живёт и на обычном формате', () => {
  const win = PP.formats.windowRect(item({ formatId: 'p-10x15' }));
  const card = PP.formats.cardSize(item({ formatId: 'p-10x15' }));
  assert.equal(card.w, 102);
  assert.equal(card.h, 152);
  assert.ok(win.h < win.w * 1.4, 'снизу остаётся широкое поле');
  assert.equal(PP.units.round(win.x, 1), PP.units.round(102 * (4.5 / 88), 1));
});

test('«в обрез» отдаёт всю карточку под снимок', () => {
  const win = PP.formats.windowRect(item({ frame: { style: 'none' } }));
  assert.equal(win.w, 88);
  assert.equal(win.h, 107);
  assert.equal(win.x, 0);
  assert.equal(win.y, 0);
});

test('ровное поле одинаково со всех сторон', () => {
  const win = PP.formats.windowRect(
    item({ formatId: 'p-13x18', frame: { style: 'edge', border: 5 } }),
  );
  assert.equal(win.x, 5);
  assert.equal(win.y, 5);
  assert.equal(win.w, 127 - 10);
  assert.equal(win.h, 178 - 10);
});

test('свой размер слушается ориентации', () => {
  const custom = item({ formatId: 'custom', custom: { w: 60, h: 90 }, orient: 'landscape' });
  const card = PP.formats.cardSize(custom);
  assert.equal(card.w, 90);
  assert.equal(card.h, 60);
});

/* ------------------------------------------------------------------ layout */

test('на A4 помещается четыре полароида', () => {
  const plan = PP.layout.build(doc([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })]));
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0].length, 4);
  plan.pages[0].forEach((card) => {
    assert.ok(card.x >= plan.sheet.x - 0.001);
    assert.ok(card.y >= plan.sheet.y - 0.001);
    assert.ok(card.x + card.w <= plan.sheet.x + plan.sheet.w + 0.001);
    assert.ok(card.y + card.h <= plan.sheet.y + plan.sheet.h + 0.001);
  });
});

test('пятый полароид уходит на второй лист', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item({ id }));
  const plan = PP.layout.build(doc(items));
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.pages[1].length, 1);
});

test('поворот листа даёт два 10 × 15 вместо одного', () => {
  const items = [item({ id: 'a', formatId: 'p-10x15' }), item({ id: 'b', formatId: 'p-10x15' })];
  const straight = PP.layout.build(doc(items, { autoRotate: false }));
  const rotated = PP.layout.build(doc(items, { autoRotate: true }));
  assert.equal(straight.pages.length, 2);
  assert.equal(rotated.pages.length, 1);
  assert.equal(rotated.pages[0][0].rot, 90);
});

test('копии размножаются, а не остаются одной карточкой', () => {
  const plan = PP.layout.build(doc([item({ copies: 3 })]));
  assert.equal(plan.cardCount, 3);
  assert.equal(plan.pages[0].length, 3);
});

test('«заполнить копиями» кладёт 30 фото на документы на лист A4', () => {
  const plan = PP.layout.build(
    doc([item({ formatId: 'd-35x45', frame: { style: 'none' } })], { mode: 'fill', gap: 2 }),
  );
  assert.equal(plan.pages.length, 1);
  // 35 × 45 с зазором 2 мм на поле 198 × 285: пять в ряд, шесть рядов.
  assert.equal(plan.pages[0].length, 30);
});

test('плотная укладка не выпускает карточки за поля', () => {
  const items = [
    item({ id: 'a', formatId: 'pol-600' }),
    item({ id: 'b', formatId: 'instax-mini' }),
    item({ id: 'c', formatId: 'pol-go' }),
    item({ id: 'd', formatId: 'instax-wide' }),
    item({ id: 'e', formatId: 's-100' }),
  ];
  const plan = PP.layout.build(doc(items, { mode: 'pack' }));
  assert.ok(plan.pages.length >= 1);
  plan.pages.forEach((page) => {
    page.forEach((card) => {
      assert.ok(card.x + card.w <= plan.sheet.x + plan.sheet.w + 0.01, 'не вылезает вправо');
      assert.ok(card.y + card.h <= plan.sheet.y + plan.sheet.h + 0.01, 'не вылезает вниз');
    });
  });
});

test('слишком большая карточка честно объявляется непоместившейся', () => {
  const plan = PP.layout.build(doc([item({ formatId: 'b-50x70' })], { mode: 'pack' }));
  assert.equal(plan.overflow.length, 1);
  assert.equal(plan.pages.length, 0);
});

test('по одному на лист — сколько кадров, столько листов', () => {
  const items = ['a', 'b', 'c'].map((id) => item({ id, formatId: 'p-13x18' }));
  const plan = PP.layout.build(doc(items, { mode: 'single' }));
  assert.equal(plan.pages.length, 3);
  plan.pages.forEach((page) => assert.equal(page.length, 1));
});

test('контрольный лист умещает всё мелко и в колонках', () => {
  const items = Array.from({ length: 12 }, (_, i) => item({ id: 'i' + i, formatId: 'p-10x15' }));
  const plan = PP.layout.build(doc(items, { mode: 'contact', contactCols: 4 }));
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0].length, 12);
  assert.ok(plan.pages[0][0].scale < 1, 'кадры уменьшены');
});

test('печать без полей действительно убирает поля', () => {
  const plan = PP.layout.build(doc([item()], { borderless: true, margin: 12 }));
  assert.equal(plan.sheet.x, 0);
  assert.equal(plan.sheet.w, 210);
});

test('заполненность листа — доля от единицы', () => {
  const plan = PP.layout.build(doc([item(), item({ id: 'b' })]));
  const share = PP.layout.coverage(plan.pages[0], plan.sheet);
  assert.ok(share > 0 && share < 1);
});

/* --------------------------------------------------------------------- pdf */

test('PDF выходит настоящим файлом нужного размера страницы', async () => {
  // Не настоящий JPEG — до распаковки дело не доходит, важна обвязка.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  const blob = PP.pdf.build(
    [{ wMm: 210, hMm: 297, jpeg, pxW: 2480, pxH: 3508 }],
    { title: 'Проба' },
  );
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');

  assert.ok(text.startsWith('%PDF-1.4'), 'заголовок на месте');
  assert.ok(text.includes('/Type /Catalog'));
  assert.ok(text.includes('/Filter /DCTDecode'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));

  // 210 мм — это 595.276 пункта; печатник ждёт именно их.
  const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
  assert.ok(box, 'MediaBox найден');
  assert.equal(Math.round(parseFloat(box[1])), 595);
  assert.equal(Math.round(parseFloat(box[2])), 842);

  // startxref должен указывать ровно на таблицу xref.
  const startxref = parseInt(/startxref\n(\d+)/.exec(text)[1], 10);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
});

test('в PDF столько страниц, сколько листов', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pages = [1, 2, 3].map(() => ({ wMm: 102, hMm: 152, jpeg, pxW: 1200, pxH: 1800 }));
  const blob = PP.pdf.build(pages, {});
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(text.includes('/Count 3'));
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 3);
});
