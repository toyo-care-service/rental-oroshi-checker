'use strict';
/* 画面（app.ui.js）をそのまま最小の偽DOMの上で動かすテスト。合成データだけを使う。
   画面の状態と表示・集計に渡す値の食い違いは test.js では拾えないため、ここで確かめる。
   実行: node test.ui.js */
const fs = require('fs');
const vm = require('vm');
const { performance } = require('perf_hooks');

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? '  OK   ' : '  NG   ') + msg);
  if (!cond) fail++;
}

// ==================== 偽DOM ====================
class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || ''; this.children = []; this.listeners = {};
    this.style = {}; this.attrs = {}; this.className = ''; this._text = '';
    this.value = ''; this.checked = false; this.disabled = false; this.files = []; this.type = '';
    this.sub = {};
    const cls = new Set();
    this.classList = {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : on; if (v) cls.add(c); else cls.delete(c); return v; }
    };
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  insertBefore(n, r) { const i = this.children.indexOf(r); this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t) { return Promise.all((this.listeners[t] || []).map(f => f({ preventDefault() {}, dataTransfer: { files: [] } }))); }
  click() {
    if (this.type === 'checkbox') { this.checked = !this.checked; this.fire('click'); return this.fire('change'); }
    if (this.type === 'radio') { this.checked = true; this.fire('click'); return this.fire('change'); }
    return this.fire('click');
  }
  querySelector(sel) { return (this.sub[sel] = this.sub[sel] || new El(sel)); }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  scrollIntoView() {}
}

/** 画面を1つ起動する。preset は localStorage に保存済みの設定 */
function boot(preset) {
  const byId = new Map();
  const store = new Map();
  if (preset !== undefined) store.set('oroshi-checker/v1', typeof preset === 'string' ? preset : JSON.stringify(preset));
  const alerts = [];
  const ui = { store, alerts, confirms: [], confirmAnswer: true };
  const sb = {
    console, performance, TextDecoder, TextEncoder, Intl, setTimeout,
    document: {
      getElementById: id => { if (!byId.has(id)) byId.set(id, new El('x', id)); return byId.get(id); },
      createElement: tag => new El(tag),
      querySelectorAll: () => []
    },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    Image: class { addEventListener() {} set src(v) {} },
    alert: m => alerts.push(String(m)),
    confirm: m => { ui.confirms.push(String(m)); return ui.confirmAnswer; }
  };
  sb.window = sb;
  vm.createContext(sb);
  const $ = id => sb.document.getElementById(id);
  ['chkSave', 'chkOneSide', 'chkPeriod'].forEach(id => { $(id).type = 'checkbox'; });
  $('chkSave').checked = true;
  $('chkOneSide').checked = true;
  $('threshold').value = '0';
  for (const f of ['vendor/xlsx.mini.min.js', 'app.core.js', 'app.match.js', 'app.xlsx.js']) {
    vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), sb, { filename: f });
  }
  // 保存の代わりに、書き出されたファイルを SheetJS で読み戻す（他の実装で開ける形になっているかの確認を兼ねる）
  let written = null;
  sb.AppXlsx.save = (bytes, name) => {
    const wb = sb.XLSX.read(bytes, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    written = { name, bytes, sheet: wb.SheetNames[0], rows: sb.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) };
  };
  vm.runInContext(fs.readFileSync(__dirname + '/app.ui.js', 'utf8'), sb, { filename: 'app.ui.js' });
  ui.$ = $; ui.written = () => written; ui.xlsx = sb.AppXlsx;
  return ui;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
/** ファイルを選び、読み込みが終わるまで待つ。delay を付けると読み込みの完了を遅らせる（続けて選んだときの順序の確認用）。
    選択の処理は呼んだ時点で同期的に始まるので、await せずに続けて呼べば「続けて選んだ」状態になる */
async function pick(ui, inputId, name, text, delay) {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  ui.$(inputId).files = [{ name, arrayBuffer: () => (delay ? wait(delay).then(() => ab) : Promise.resolve(ab)) }];
  ui.$(inputId).fire('change');
  await wait((delay || 0) + 30);
}
async function loadBoth(ui, renta, para) {
  await pick(ui, 'filePara', 'para.csv', para === undefined ? PARA : para);
  await pick(ui, 'fileRenta', 'renta.xls', renta === undefined ? RENTA : renta);
}
const hidden = (ui, id) => ui.$(id).classList.contains('hidden');
const heads = ui => ui.$('mapTable').querySelector('thead').children[0].children.map(c => c.textContent);
const mapRows = ui => ui.$('mapTable').querySelector('tbody').children;
const rowOf = (ui, b, c) => mapRows(ui).find(tr => tr.children[0].textContent === b && tr.children[1].textContent === c);
const cellOf = (ui, tr, name) => tr.children[heads(ui).indexOf(name)].children[0];
const ignoreCell = (ui, name) => mapRows(ui)[0].children[heads(ui).indexOf(name) - 4].children[0];
const bumonRadio = (ui, name) => { const l = ui.$('bumonPick').children.find(x => x.children[1].textContent.indexOf(name) === 0); return l && l.children[0]; };
const chooseBumon = (ui, name) => bumonRadio(ui, name).click();
const resultNames = ui => ui.$('resultTable').querySelector('tbody').children.map(tr => tr.children[2].textContent.replace(/[\s　]/g, ''));
const saved = ui => JSON.parse(ui.store.get('oroshi-checker/v1'));
async function runNow(ui) {
  if (!ui.$('chkPeriod').checked) await ui.$('chkPeriod').click();
  await ui.$('btnRun').click();
}

// ==================== 合成データ（test.js と同じ形） ====================
const RH = ['年度', '部門コード', '部門名', '仕入先コード', '仕入先名', 'お客様番号', 'お客様名', 'お客様名ｶﾅ',
  '取次利用者番号', '利用者名', '利用者名ｶﾅ', '商品', '商品名', '利用者料金', '卸先料金', '決定卸先料金',
  '決定借受料(税抜)', '決定卸先消費税', '決定卸先消費税区分', '使用日数', '取引開始日', '取引停止日',
  '給付方法', '料金分類', '料金参照', '納品書番号', '中止理由', '備考', '支払のみ発生', '未確定'];
const R = rows => [RH.join('\t')].concat(rows.map(o => RH.map(h => (o[h] == null ? '' : String(o[h]))).join('\t'))).join('\r\n');
const PH = ['請求先名', '得意先名', '利用者コード', '利用者名', '利用者カナ', 'マーク', '区分', '伝票No',
  '拠点', '商品コード', '商品名', '型式', '開始日', '終了日', '中断日', '再開日', '数量', '単位', '金額', '税'];
const qq = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const P = (rows, header) => {
  const h = header || PH;
  return [h.map(qq).join(',')].concat(rows.map(o => h.map(k => qq(o[k])).join(','))).join('\r\n');
};

// X部門: 仕入先900（Z営業所と組む。2人）と仕入先905（別の卸元。請求データには出てこない）
// V部門: 仕入先901（W営業所と組む。1人）
const base = { 年度: '2026年8月', 部門コード: '1', 部門名: 'X部門', 仕入先コード: '900', 仕入先名: 'Y卸元', 決定卸先消費税区分: '外税' };
const rentaRows = [
  Object.assign({}, base, { お客様番号: '1001', 利用者名: '試験 一号', 利用者名ｶﾅ: 'ｼｹﾝ ｲﾁｺﾞｳ', 商品: 'R01', 商品名: '手すり AAA-1000', '決定借受料(税抜)': '4,000' }),
  Object.assign({}, base, { お客様番号: '1002', 利用者名: '試験 二号', 利用者名ｶﾅ: 'ｼｹﾝ ﾆｺﾞｳ', 商品: 'R02', 商品名: '歩行車 BBB-2000', '決定借受料(税抜)': '2,000' }),
  Object.assign({}, base, { 仕入先コード: '905', 仕入先名: 'Q卸元', お客様番号: '1004', 利用者名: '試験 四号', 利用者名ｶﾅ: 'ｼｹﾝ ﾖﾝｺﾞｳ', 商品: 'R04', 商品名: '車いす DDD-4000', '決定借受料(税抜)': '5,000' }),
  Object.assign({}, base, { 部門名: 'V部門', 仕入先コード: '901', お客様番号: '2001', 利用者名: '試験 三号', 利用者名ｶﾅ: 'ｼｹﾝ ｻﾝｺﾞｳ', 商品: 'R03', 商品名: 'ベッド CCC-3000', '決定借受料(税抜)': '9,000', 決定卸先消費税区分: '非課税' })
];
const paraRows = [
  { 利用者コード: 'A01', 利用者名: '試験　一号', 利用者カナ: 'シケン　イチゴウ', 拠点: 'Z営業所', 商品名: '手すり  AAA-1000', 型式: 'AAA-1000', 金額: '3,000', 税: '10%' },
  { 利用者コード: 'A02', 利用者名: '試験　二号', 利用者カナ: 'シケン　ニゴウ', 拠点: 'Z営業所', 商品名: '歩行車  BBB-2000', 型式: 'BBB-2000', 金額: '2,000', 税: '10%' },
  { 利用者コード: 'A03', 利用者名: '試験　三号', 利用者カナ: 'シケン　サンゴウ', 拠点: 'W営業所', 商品名: 'ベッド  CCC-3000', 型式: 'CCC-3000', 金額: '9,500', 税: '非' }
];
const RENTA = R(rentaRows);
const RENTA_X_ONLY = R(rentaRows.filter(r => r.部門名 === 'X部門'));
const RENTA_2MONTHS = R(rentaRows.concat([Object.assign({}, rentaRows[0], { 年度: '2026年7月' })]));
const RENTA_OTHER = R(rentaRows.map(r => Object.assign({}, r, { 年度: '2026年9月' })));
const PARA = P(paraRows);
const PARA_W_ONLY = P(paraRows.filter(r => r.拠点 === 'W営業所'));
const PARA_NO_TAX = P(paraRows, PH.filter(h => h !== '税'));

/** アプリ自身が書き出す形の設定（X部門を選び、仕入先900をZ営業所と組み、仕入先905とW営業所は対象外） */
const goodCfg = () => ({
  version: 1, savedAt: '2026-09-29T00:00:00.000Z', bumon: 'X部門',
  mappings: [
    { bumon: 'X部門', shiireCd: '900', kyoten: ['Z営業所'], ignore: false },
    { bumon: 'X部門', shiireCd: '905', kyoten: [], ignore: true }
  ],
  ignoreKyotenByBumon: { 'X部門': ['W営業所'] }, confirmed: [], exclPara: [], exclRenta: [], threshold: 0, showOneSide: true
});

(async () => {
  console.log('== 拠点を選んで、その拠点の分だけを突合する ==');
  {
    const ui = boot();
    await loadBoth(ui);
    ok(/拠点の選択/.test(ui.$('runHint').textContent) && ui.$('btnRun').disabled, '拠点を選ぶまでは突合できず、理由が出る');
    ok(mapRows(ui).length === 0 && /拠点を選んでください/.test(ui.$('mapMsg').textContent), '拠点を選ぶまで対応表は出ない');
    ok(ui.$('bumonPick').children.length === 2, '支払予定表にある拠点（部門）が選択肢に並ぶ');
    await chooseBumon(ui, 'X部門');
    ok(!!rowOf(ui, 'X部門', '900') && !!rowOf(ui, 'X部門', '905') && !rowOf(ui, 'V部門', '901'), '対応表には、選んだ拠点の仕入先だけが並ぶ');
    await ui.$('btnSuggest').click();
    ok(cellOf(ui, rowOf(ui, 'X部門', '900'), 'Z営業所').checked, '候補：利用者が重なる卸元の拠点と組む');
    ok(cellOf(ui, rowOf(ui, 'X部門', '905'), '対象外').checked, '候補：請求データに出てこない仕入先は対象外');
    ok(ignoreCell(ui, 'W営業所').checked, '候補：ほかの拠点（部門）と重なる卸元の拠点は、この拠点では対象外');
    ok(/全拠点が、いずれかの組に割り当てられているか、対象外/.test(ui.$('mapMsg').textContent), '設定の漏れが無いことが分かる');
    await runNow(ui);
    ok(!hidden(ui, 'cardResult') && /X部門/.test(ui.$('kpi').textContent), '結果に、どの拠点の分かが出る');
    ok(resultNames(ui).join() === '試験一号', '一覧には選んだ拠点の人だけが出る（ほかの拠点の人は混ざらない）');
    ok(!/範囲外/.test(ui.$('resultMsgs').textContent), 'ほかの拠点の行は対象外として扱い、判定不能には数えない');
    await ui.$('btnXlsx').click();
    const w = ui.written();
    ok(w && /_X部門\.xlsx$/.test(w.name), '出力のファイル名に拠点が入る');
    ok(w && /2026年8月/.test(w.rows[0][0]) && /X部門/.test(w.rows[0][0]), '出力の題名に年月と拠点が入る');
  }

  console.log('== 出力は、要点・書式つきの表・条件の順に並ぶ ==');
  {
    // 一号は、金額の違いに加えて、卸元にしか無い明細も持つ（不一致の内容が2行になる）。
    // 卸元の利用者コードを分けてあるので、人にかかわる長い注記（合算）も付く
    const extra = paraRows.concat([{ 利用者コード: 'A09', 利用者名: '試験　一号', 利用者カナ: 'シケン　イチゴウ', 拠点: 'Z営業所', 商品名: 'テーブル  EEE-5000', 型式: 'EEE-5000', 金額: '700', 税: '10%' }]);
    const ui = boot(goodCfg());
    await loadBoth(ui, RENTA, P(extra));
    await runNow(ui);
    await ui.$('btnXlsx').click();
    const w = ui.written();
    const flat = w.rows.map(r => r.join('|'));
    ok(w.sheet === '金額不一致一覧' && w.rows.length > 0, '書き出したファイルを、別の実装（SheetJS）で読み戻せる');
    const sumAt = w.rows.findIndex(r => r[0] === '不一致の人数');
    ok(sumAt === 1 && w.rows[2][0] === '1人' && w.rows[1][4] === 'スマートれん太 計' && w.rows[2][4] === 6000 && w.rows[1][6] === '卸元の請求 計' && w.rows[2][6] === 5700 && w.rows[1][8] === '差額 計' && w.rows[2][8] === 300, '題名のすぐ下に、人数と合計が出る。合計は、それぞれの金額の列の上に数値で置く');
    const headAt = w.rows.findIndex(r => r[0] === 'お客様番号');
    ok(headAt > 2 && w.rows[headAt].join('|') === 'お客様番号|お客様名|利用者名|商品名|スマートれん太|税区分|卸元の請求|税区分|差額|不一致の内容|注記|両側の表記', '表の見出しが並ぶ（金額の右隣に、それぞれの税区分）');
    const row = w.rows[headAt + 1];
    const row2 = w.rows[headAt + 2] || [];
    ok(row[2].replace(/[\s　]/g, '') === '試験一号' && /AAA-1000/.test(row[3]) && row[4] === 4000 && row[5] === '課税' && row[6] === 3000 && row[7] === '課税' && row[8] === 1000 && row[9] === '金額が違う', '1行に、明細1件の商品名・両側の金額と税区分・差額・内容が並ぶ。金額は数値');
    ok(/EEE-5000/.test(row2[3]) && row2[4] === '' && row2[5] === '' && row2[6] === 700 && row2[7] === '課税' && row2[8] === -700 && row2[9] === 'れん太に無し', '片側にしか無い明細は、無い側の金額と税区分を空にする');
    ok([0, 1, 2, 11].every(i => row2[i] === '' || row2[i] == null), '同じ人の2行目からは、番号・氏名・両側の表記を空にする');
    ok(row[8] + row2[8] === 300, '明細の差額を足すと、その人の差額になる');
    ok(/合算/.test(row[10]) && /明細説明未確定/.test(row[10]) && row2[10] === '明細説明未確定', '注記は最初の行に全部出し、続きの行には「明細説明未確定」だけを繰り返す');
    ok((w.rows[headAt + 3] || []).join('') === '', '表の行数は、不一致の明細の数と同じ');
    ok(!flat.slice(0, headAt).some(x => /^注意：/.test(x)), '異常が無ければ、注意は出さない');
    ok(flat.some(x => /^この一覧の条件/.test(x)) && flat.some(x => /^入力ファイル：/.test(x)) && flat.findIndex(x => /^入力ファイル：/.test(x)) > headAt + 1, '細かい条件は表の下にまとめる');
    const raw = Buffer.from(w.bytes).toString('latin1');
    ok(/xl\/styles\.xml/.test(raw) && /4F46E5/.test(raw) && /wrapText="1"/.test(raw) && /\[Red\]/.test(raw), '見出しの色・折り返し・マイナスの赤字の書式が入っている');
    ok(/<pane ySplit="/.test(raw) && /orientation="landscape"/.test(raw) && /_xlnm.Print_Titles/.test(raw), '見出しの固定・横向き印刷・印刷時の見出しの繰り返しが入っている');
    ok(!/<autoFilter/.test(raw), '絞り込み（並べ替え）は付けない。並べ替えると、続きの行が誰の明細か分からなくなる');

    // 税区分が違う明細は、金額が同じでも1行に出て、両側の税区分が並ぶ
    const u3 = boot(goodCfg());
    await loadBoth(u3, RENTA, P(paraRows.map(r => (r.利用者コード === 'A02' ? Object.assign({}, r, { 税: '非' }) : r))));
    await runNow(u3);
    await u3.$('btnXlsx').click();
    const w3 = u3.written();
    const t3 = w3.rows.slice(w3.rows.findIndex(r => r[0] === 'お客様番号') + 1).find(r => r[9] === '課税区分が違う');
    ok(!!t3 && t3[4] === 2000 && t3[5] === '課税' && t3[6] === 2000 && t3[7] === '非課税' && t3[8] === 0, '税区分だけが違う明細は、同じ金額と、違う税区分が並ぶ');
    ok(/FFB42318/.test(Buffer.from(w3.bytes).toString('latin1')) && !/FFB42318/.test(raw), '税区分が違う明細だけ、税区分を赤字にする');

    // 突合していない行が残るときは、上に注意を出す
    const c = goodCfg(); c.mappings[1] = { bumon: 'X部門', shiireCd: '905', kyoten: ['K営業所'], ignore: false };
    const u2 = boot(c);
    await loadBoth(u2);
    await runNow(u2);
    await u2.$('btnXlsx').click();
    const f2 = u2.written().rows.map(r => r.join('|'));
    ok(f2.slice(0, 6).some(x => /^注意：突合していない行 1行/.test(x)), '突合していない行があれば、題名の近くに注意を出す');
  }

  console.log('== Excel を作れないときは、ファイルを出さずに理由を出す ==');
  {
    const ui = boot(goodCfg());
    const X = ui.xlsx;
    const one = v => ({ sheetName: 's', cols: [10], rows: [{ cells: [{ v }] }] });
    const thrown = f => { try { f(); return ''; } catch (e) { return e.message; } };
    ok(thrown(() => X.build(one('あ'.repeat(32767)))) === '', '1セル 32,767文字までは書き出せる');
    ok(/セル A1 の文字数（32,768文字）が、Excel の上限（32,767文字）/.test(thrown(() => X.build(one('あ'.repeat(32768))))), '1セルが 32,768文字なら、どのセルかを添えて止める');
    ok(thrown(() => X.build(one('あ'.repeat(32767) + '\u0000\u0001'))) === '', '捨てる制御文字は文字数に数えない');
    ok(/行数（1,048,577行）が、Excel の上限（1,048,576行）/.test(thrown(() => X.build({ sheetName: 's', cols: [10], rows: { length: 1048577, forEach() {} } }))), '行数が上限を超えたら止める');

    await loadBoth(ui);
    await runNow(ui);
    const build = X.build;
    X.build = () => { throw new Error('試験用の失敗'); };
    await ui.$('btnXlsx').click();
    ok(!ui.written() && /Excel を作れませんでした。ファイルは保存されていません。理由：試験用の失敗/.test(ui.$('xlsxMsg').textContent), '書き出しに失敗したら、保存せずに理由を画面に出す');
    X.build = build;
    await ui.$('btnXlsx').click();
    ok(!!ui.written() && ui.$('xlsxMsg').textContent === '', 'もう一度押して成功したら、前の失敗の表示は消える');
    X.build = () => { throw new Error('試験用の失敗'); };
    await ui.$('btnXlsx').click();
    await runNow(ui);
    ok(ui.$('xlsxMsg').textContent === '', '突合し直したら、前の失敗の表示は消える');
    X.build = build;
  }

  console.log('== 設定は拠点ごとに持ち、切り替えても互いに影響しない ==');
  {
    const ui = boot();
    await loadBoth(ui);
    await chooseBumon(ui, 'X部門');
    await ui.$('btnSuggest').click();
    await chooseBumon(ui, 'V部門');
    ok(!!rowOf(ui, 'V部門', '901') && !rowOf(ui, 'X部門', '900'), '拠点を切り替えると、対応表もその拠点のものになる');
    await ui.$('btnSuggest').click();
    ok(cellOf(ui, rowOf(ui, 'V部門', '901'), 'W営業所').checked && ignoreCell(ui, 'Z営業所').checked, 'V部門では W営業所と組み、Z営業所は対象外');
    await runNow(ui);
    ok(resultNames(ui).join() === '試験三号', 'V部門の結果には V部門の人だけが出る');
    await chooseBumon(ui, 'X部門');
    ok(hidden(ui, 'cardResult'), '拠点を切り替えると、前の拠点の結果は隠れる');
    ok(cellOf(ui, rowOf(ui, 'X部門', '900'), 'Z営業所').checked && ignoreCell(ui, 'W営業所').checked, 'X部門に戻すと、X部門の設定がそのまま残っている');
    await ignoreCell(ui, 'W営業所').click();
    await ignoreCell(ui, 'W営業所').click();
    const c = saved(ui);
    ok(c.mappings.find(m => m.bumon === 'V部門').kyoten.join() === 'W営業所', 'X部門で W営業所を対象外にしても、V部門の組み合わせは消えない');
    ok(c.ignoreKyotenByBumon['X部門'].join() === 'W営業所' && c.ignoreKyotenByBumon['V部門'].join() === 'Z営業所', '対象外の拠点は、拠点ごとに保存される');
    await ui.$('btnMapClear').click();
    ok(!saved(ui).mappings.some(m => m.bumon === 'X部門') && saved(ui).mappings.some(m => m.bumon === 'V部門'), '「この拠点の設定を空にする」は、選んでいる拠点の設定だけを消す');

    const again = boot(ui.store.get('oroshi-checker/v1'));
    await loadBoth(again);
    ok(bumonRadio(again, 'X部門').checked, '前回選んだ拠点が、次に開いたときも選ばれている');
  }

  console.log('== 拠点の取り違えに気づける ==');
  {
    const ui = boot();
    await loadBoth(ui, RENTA, PARA_W_ONLY);
    await chooseBumon(ui, 'X部門');
    ok(/別の拠点の請求データ/.test(ui.$('mapMsg').textContent), '選んだ拠点の利用者が請求データにいなければ、別の拠点のファイルを疑う警告を出す');
    await chooseBumon(ui, 'V部門');
    ok(!/別の拠点の請求データ/.test(ui.$('mapMsg').textContent), '利用者が重なる拠点を選べば警告は出ない');

    const one = boot();
    await loadBoth(one, RENTA_X_ONLY, PARA);
    ok(bumonRadio(one, 'X部門').checked && !/拠点の選択/.test(one.$('runHint').textContent), '支払予定表に拠点が1つしか無ければ、その拠点が選ばれる');
  }

  console.log('== 残してある設定が、今月の結果に混ざらない ==');
  {
    // ほかの拠点（部門）が同じ卸元の拠点と組む設定、今月のファイルに無い組の設定が残っていても、結果は変わらない
    const c = goodCfg();
    c.mappings.push({ bumon: 'V部門', shiireCd: '901', kyoten: ['Z営業所'], ignore: false });
    c.mappings.push({ bumon: 'X部門', shiireCd: '999', kyoten: ['Z営業所'], ignore: false });
    const ui = boot(c);
    await loadBoth(ui);
    ok(!/同じ拠点が複数の組/.test(ui.$('mapMsg').textContent), '見えていない設定とは、拠点の重複として扱わない');
    await runNow(ui);
    ok(resultNames(ui).join() === '試験一号', '残してある設定があっても、選んだ拠点の人が正しい相手と結ばれる');
    ok(/対象人数/.test(ui.$('kpi').textContent) && /2人/.test(ui.$('kpi').textContent), '対象は選んだ拠点の2人だけ');
  }

  console.log('== 今月のファイルに無い拠点とだけ組んでいる組は、警告して突合しない ==');
  {
    const c = goodCfg();
    c.mappings[1] = { bumon: 'X部門', shiireCd: '905', kyoten: ['K営業所'], ignore: false };
    const ui = boot(c);
    await loadBoth(ui);
    ok(/今月のファイルに無い拠点とだけ組んでいる組があります：X部門×905（1行 5,000円）/.test(ui.$('mapMsg').textContent), '組と行数・金額を挙げて警告する');
    ok(/今月のファイルに無い拠点：K営業所/.test(rowOf(ui, 'X部門', '905').children[2].textContent), '組の行に、今月のファイルに無い拠点を添える');
    await runNow(ui);
    ok(resultNames(ui).join() === '試験一号', 'その組の人は一覧に出ない（卸元に無い、とは扱わない）');
    ok(/範囲外 1行/.test(ui.$('resultMsgs').textContent), 'その組の行は、判定不能（範囲外）として数える');
    ok(saved(ui).mappings.find(m => m.shiireCd === '905').kyoten.join() === 'K営業所', '設定は残る');
    ui.confirmAnswer = false;
    await cellOf(ui, rowOf(ui, 'X部門', '905'), '対象外').click();
    ok(ui.confirms.length === 1 && /K営業所/.test(ui.confirms[0]), '見えていない拠点と組んだ組を対象外にするときは、確かめる');
    ok(saved(ui).mappings.find(m => m.shiireCd === '905').kyoten.join() === 'K営業所', '取りやめれば、設定は変わらない');
  }

  console.log('== 行の無い月をまたいでも、対応表の設定は残る ==');
  {
    // 仕入先900は Z営業所と W2営業所（今月は行が無い）と組む。仕入先905は今月のファイルに行が無い
    const c = goodCfg();
    c.mappings[0].kyoten = ['Z営業所', 'W2営業所'];
    const ui = boot(c);
    const RENTA_NO_905 = R(rentaRows.filter(r => r.仕入先コード !== '905'));
    await loadBoth(ui, RENTA_NO_905, PARA);
    ok(/今月のファイルに無い組 1組・拠点 1件/.test(ui.$('mapMsg').textContent), '今月のファイルに無い組・拠点の設定を残していることを知らせる');
    ok(/今月のファイルに無い拠点：W2営業所/.test(rowOf(ui, 'X部門', '900').children[2].textContent), '組の行に、今月のファイルに無い拠点を添える');
    await runNow(ui);
    await ui.$('btnSuggest').click();
    const s = saved(ui);
    ok(s.mappings.find(m => m.shiireCd === '905').ignore === true, '今月のファイルに無い組の設定は、突合しても「候補を出す」を押しても消えない');
    ok(s.mappings.find(m => m.shiireCd === '900').kyoten.includes('W2営業所'), '今月のファイルに無い拠点も、組の設定から消えない');
    const back = boot(JSON.stringify(s));
    await loadBoth(back);
    ok(cellOf(back, rowOf(back, 'X部門', '905'), '対象外').checked, '行が戻ってきた月は、前の設定のまま');
    ok(!/割り当てられていない拠点|指定していない組/.test(back.$('mapMsg').textContent), '設定し直しを求める警告は出ない');
  }

  console.log('== 読み込みに失敗したら、前のファイルの表示も消す ==');
  {
    const ui = boot();
    await pick(ui, 'filePara', 'para.csv', PARA);
    await pick(ui, 'fileRenta', 'renta_ok.xls', RENTA);
    ok(ui.$('dropRenta').classList.contains('done') && /renta_ok/.test(ui.$('fnRenta').textContent), '（前提）正しいファイルは読込済みと表示される');
    ok(!hidden(ui, 'cardPeriod'), '（前提）年月の確認に進める');
    await pick(ui, 'fileRenta', 'renta_2months.xls', RENTA_2MONTHS);
    ok(!ui.$('dropRenta').classList.contains('done') && ui.$('fnRenta').textContent === '', '年月が2種類のファイルに差し替えると、前のファイルの読込済み表示が消える');
    ok(/年月が2種類/.test(ui.$('loadMsgRenta').textContent), '理由が支払予定表の欄に出る');
    ok(hidden(ui, 'cardPeriod') && hidden(ui, 'cardRun'), '未読込として、年月の確認以降に進めない');
    await pick(ui, 'filePara', 'para.csv', PARA);
    ok(/年月が2種類/.test(ui.$('loadMsgRenta').textContent), '請求データを読み直しても、支払予定表の注意は消えない');
  }

  console.log('== 続けて選んだときは、最後に選んだファイルを使う ==');
  {
    const ui = boot();
    await pick(ui, 'filePara', 'para.csv', PARA);
    const slow = pick(ui, 'fileRenta', 'renta_first.xls', RENTA, 60);
    const fast = pick(ui, 'fileRenta', 'renta_last.xls', RENTA_OTHER);
    await Promise.all([slow, fast]);
    ok(/renta_last/.test(ui.$('fnRenta').textContent), '先に選んだファイルの読み込みが後から終わっても、最後に選んだファイルが残る');
    ok(/2026年9月/.test(ui.$('periodText').textContent), '年月も最後に選んだファイルのもの');
    const slowP = pick(ui, 'filePara', 'para_first.csv', PARA, 60);
    const fastP = pick(ui, 'filePara', 'para_last.csv', PARA_NO_TAX);
    await Promise.all([slowP, fastP]);
    ok(/para_last/.test(ui.$('fnPara').textContent), '請求データでも、最後に選んだファイルが残る');
  }

  console.log('== 保存された設定は、アプリが書き出す形だけを受け付ける ==');
  {
    const bad = [
      ['対応表に null', c => { c.mappings.push(null); }],
      ['対象外が文字列', c => { c.mappings[1].ignore = 'false'; }],
      ['拠点に空文字', c => { c.mappings[0].kyoten = ['']; }],
      ['突合する組なのに拠点が空', c => { c.mappings[0].kyoten = []; }],
      ['対象外の組に拠点', c => { c.mappings[1].kyoten = ['W営業所']; }],
      ['選んだ拠点が数値', c => { c.bumon = 5; }],
      ['拠点ごとの対象外が配列', c => { c.ignoreKyotenByBumon = ['W営業所']; }],
      ['拠点ごとの対象外の中身が文字列でない', c => { c.ignoreKyotenByBumon = { 'X部門': [1] }; }],
      ['表示の切替が文字列', c => { c.showOneSide = 'yes'; }],
      ['確認済みの日時が数値', c => { c.confirmed = [{ paraKey: 'C\tA01', rentaKey: '1001\t試験一号', at: 5 }]; }],
      ['除外条件に null', c => { c.exclPara = [null]; }]
    ];
    for (const [label, mutate] of bad) {
      const c = goodCfg(); mutate(c);
      let crashed = false, ui = null;
      try { ui = boot(c); } catch (e) { crashed = true; }
      ok(!crashed && ui.alerts.length === 1, label + ' → 起動は止まらず、使えない設定として知らせる');
    }
    ok(boot(goodCfg()).alerts.length === 0, 'アプリが書き出す形の設定はそのまま使える');
    const old = goodCfg(); delete old.bumon; delete old.ignoreKyotenByBumon; old.ignoreKyoten = ['W営業所'];
    ok(boot(old).alerts.length === 0, '拠点を選ぶ前の版が保存した設定も読める（拠点は選び直す）');

    // 画面で操作して保存された設定を、次に開いたときに読み込めること
    const u2 = boot();
    await loadBoth(u2);
    await chooseBumon(u2, 'X部門');
    await u2.$('btnSuggest').click();
    await u2.$('btnExclCheap').click();
    ok(boot(u2.store.get('oroshi-checker/v1')).alerts.length === 0, '画面で操作して保存された設定は、次に開いたときにそのまま使える');
  }

  console.log('== 設定ファイルを読み込んだら、今のファイルで対応表を描き直す ==');
  {
    const ui = boot();
    await loadBoth(ui);
    const c = goodCfg();
    c.mappings.push({ bumon: 'X部門', shiireCd: '999', kyoten: ['K営業所'], ignore: false });
    ui.$('fileCfg').value = 'cfg.json';
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(c) }];
    await ui.$('fileCfg').fire('change');
    ok(ui.alerts.length === 0, '（前提）設定ファイルは使える形');
    ok(bumonRadio(ui, 'X部門').checked && cellOf(ui, rowOf(ui, 'X部門', '900'), 'Z営業所').checked, '設定ファイルの拠点と対応表が画面に出る');
    ok(/今月のファイルに無い組 1組/.test(ui.$('mapMsg').textContent), 'ファイルに無い組は、設定を残したうえでその旨を出す');
    ok(saved(ui).mappings.some(m => m.shiireCd === '999'), '今月のファイルに無い組も、保存される設定に残る');
    ok(ui.$('fileCfg').value === '', '同じ設定ファイルを選び直せるよう、選択を空に戻す');
    const bad = goodCfg(); bad.mappings[0].ignore = 'no';
    ui.$('fileCfg').value = 'bad.json';
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(bad) }];
    await ui.$('fileCfg').fire('change');
    ok(ui.alerts.length === 1 && ui.$('fileCfg').value === '', '使えない設定ファイルでも、選択は空に戻る');
  }

  console.log('== 割り当てと対象外が重なった設定は、割り当てを優先して表示する ==');
  {
    const c = goodCfg(); c.ignoreKyotenByBumon['X部門'] = ['W営業所', 'Z営業所'];
    const ui = boot(c);
    await loadBoth(ui);
    ok(ignoreCell(ui, 'Z営業所').checked === false, '割り当て済みの拠点は、対象外のチェックが外れる');
    ok(ignoreCell(ui, 'W営業所').checked === true, '割り当てていない拠点は対象外のまま');
  }

  console.log('== 設定を変えたら、前の結果は使わせない ==');
  {
    const ui = boot(goodCfg());
    await loadBoth(ui);
    await runNow(ui);
    ok(!hidden(ui, 'cardResult'), '（前提）突合すると結果が出る');
    await ui.$('btnXlsx').click();
    const w = ui.written();
    ok(w && w.rows.some(r => /対象外にした卸元の拠点（W営業所）/.test(r[0])), '出力の「この一覧の条件」に、対象外にした拠点が出る');
    await ignoreCell(ui, 'W営業所').click();
    ok(hidden(ui, 'cardResult'), '対象外の指定を変えると、前の結果は隠れる');
    await ui.$('btnRun').click();
    ok(!hidden(ui, 'cardResult'), '突合し直せば結果が出る');
  }

  console.log('== 課税区分を読めないファイルには注意を出し続ける ==');
  {
    const ui = boot();
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    await pick(ui, 'filePara', 'para_no_tax.csv', PARA_NO_TAX);
    ok(/請求データの課税区分/.test(ui.$('taxMsg').textContent), '税の列が無い請求データには注意が出る');
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    ok(/請求データの課税区分/.test(ui.$('taxMsg').textContent), '支払予定表を読み直しても注意は残る');
    await pick(ui, 'filePara', 'para.csv', PARA);
    ok(ui.$('taxMsg').textContent === '', '正しい請求データに差し替えると注意は消える');
  }

  console.log('== 選び直した瞬間に前の結果を隠し、読み終わるまで突合させない ==');
  {
    const ui = boot(goodCfg());
    await loadBoth(ui);
    await runNow(ui);
    ok(!hidden(ui, 'cardResult'), '（前提）突合すると結果が出る');
    const done = pick(ui, 'filePara', 'para_next.csv', PARA, 60);
    ok(hidden(ui, 'cardResult'), 'ファイルを選んだ瞬間に前の結果が隠れる（読み込み中に前の結果を出力できない）');
    ok(ui.$('btnRun').disabled && /ファイルの読み込み/.test(ui.$('runHint').textContent), '読み込み中は突合できず、理由が出る');
    await done;
    ok(!/ファイルの読み込み/.test(ui.$('runHint').textContent), '読み終われば、読み込み中の理由は消える');
    await ui.$('chkPeriod').click();
    ok(!ui.$('btnRun').disabled, '読み終わって年月を確認すれば突合できる');
  }

  console.log('== データが1行も無いファイルは、理由を添えて読み込み失敗にする ==');
  {
    const ui = boot();
    await pick(ui, 'filePara', 'para.csv', PARA);
    await pick(ui, 'fileRenta', 'renta_empty.xls', R([]));
    ok(/データが1行もありません/.test(ui.$('loadMsgRenta').textContent) && ui.$('fnRenta').textContent === '', '支払予定表が0行なら、その理由を出して未読込にする');
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    await pick(ui, 'filePara', 'para_empty.csv', P([]));
    ok(/データが1行もありません/.test(ui.$('loadMsgPara').textContent) && !ui.$('dropPara').classList.contains('done'), '請求データが0行なら、その理由を出して未読込にする');
    ok(hidden(ui, 'cardPeriod'), '0行のファイルでは先に進めない');
  }

  console.log('== 設定ファイルを続けて選んだら、最後に選んだ方を使う ==');
  {
    const ui = boot();
    await loadBoth(ui);
    const first = goodCfg(); first.threshold = 5;
    const last = goodCfg(); last.threshold = 9;
    ui.$('fileCfg').files = [{ text: () => wait(60).then(() => JSON.stringify(first)) }];
    ui.$('fileCfg').fire('change');
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(last) }];
    ui.$('fileCfg').fire('change');
    await wait(120);
    ok(String(ui.$('threshold').value) === '9', '先に選んだ設定ファイルが後から読み終わっても、最後に選んだ方が残る');
    ui.$('fileCfg').files = [{ text: () => wait(60).then(() => { throw new Error('読めない'); }) }];
    ui.$('fileCfg').fire('change');
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(last) }];
    ui.$('fileCfg').fire('change');
    await wait(120);
    ok(ui.alerts.length === 0, '先に選んだ設定ファイルが読めなくても、後から選んだ方が使えれば警告は出さない');
    const other = goodCfg(); other.threshold = 3;
    ui.$('fileCfg').files = [{ text: () => wait(60).then(() => JSON.stringify(other)) }];
    ui.$('fileCfg').fire('change');
    ui.$('fileCfg').files = [{ text: async () => { throw new Error('読めない'); } }];
    ui.$('fileCfg').fire('change');
    await wait(120);
    ok(ui.alerts.length === 1 && String(ui.$('threshold').value) === '9', '後から選んだ方が読めなければ警告を1回出し、先に選んだ方でも上書きしない');
    ui.$('fileCfg').files = [{ text: () => wait(60).then(() => { throw new Error('読めない'); }) }];
    ui.$('fileCfg').fire('change');
    ui.$('fileCfg').files = [{ text: async () => { throw new Error('読めない'); } }];
    ui.$('fileCfg').fire('change');
    await wait(120);
    ok(ui.alerts.length === 2, '両方読めなければ、警告は最後に選んだ方の1回だけ');
  }

  console.log('\n' + (fail ? '!! ' + fail + ' 件失敗' : '全項目 OK'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
