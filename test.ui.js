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
  const sb = {
    console, performance, TextDecoder, Intl, setTimeout,
    document: {
      getElementById: id => { if (!byId.has(id)) byId.set(id, new El('x', id)); return byId.get(id); },
      createElement: tag => new El(tag),
      querySelectorAll: () => []
    },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    Image: class { addEventListener() {} set src(v) {} },
    alert: m => alerts.push(String(m)),
    confirm: () => true
  };
  sb.window = sb;
  vm.createContext(sb);
  const $ = id => sb.document.getElementById(id);
  ['chkSave', 'chkOneSide', 'chkPeriod'].forEach(id => { $(id).type = 'checkbox'; });
  $('chkSave').checked = true;
  $('chkOneSide').checked = true;
  $('threshold').value = '0';
  for (const f of ['vendor/xlsx.mini.min.js', 'app.core.js', 'app.match.js']) {
    vm.runInContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), sb, { filename: f });
  }
  let written = null;
  sb.XLSX.writeFile = (wb, name) => {
    const ws = wb.Sheets[wb.SheetNames[0]];
    written = { name, rows: sb.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) };
  };
  vm.runInContext(fs.readFileSync(__dirname + '/app.ui.js', 'utf8'), sb, { filename: 'app.ui.js' });
  return { $, store, alerts, written: () => written };
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
const hidden = (ui, id) => ui.$(id).classList.contains('hidden');
const heads = ui => ui.$('mapTable').querySelector('thead').children[0].children.map(c => c.textContent);
const rowOf = (ui, b, c) => ui.$('mapTable').querySelector('tbody').children.find(tr => tr.children[0].textContent === b && tr.children[1].textContent === c);
const cellOf = (ui, tr, name) => tr.children[heads(ui).indexOf(name)].children[0];
const ignoreRow = ui => ui.$('mapTable').querySelector('tbody').children[0];
const ignoreCell = (ui, name) => ignoreRow(ui).children[heads(ui).indexOf(name) - 4].children[0];

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

const base = { 年度: '2026年8月', 部門コード: '1', 部門名: 'X部門', 仕入先コード: '900', 仕入先名: 'Y卸元', 決定卸先消費税区分: '外税' };
const rentaRows = [
  Object.assign({}, base, { お客様番号: '1001', 利用者名: '試験 一号', 利用者名ｶﾅ: 'ｼｹﾝ ｲﾁｺﾞｳ', 商品: 'R01', 商品名: '手すり AAA-1000', '決定借受料(税抜)': '4,000' }),
  Object.assign({}, base, { お客様番号: '1002', 利用者名: '試験 二号', 利用者名ｶﾅ: 'ｼｹﾝ ﾆｺﾞｳ', 商品: 'R02', 商品名: '歩行車 BBB-2000', '決定借受料(税抜)': '2,000' }),
  Object.assign({}, base, { 部門名: 'V部門', 仕入先コード: '901', お客様番号: '2001', 利用者名: '試験 三号', 利用者名ｶﾅ: 'ｼｹﾝ ｻﾝｺﾞｳ', 商品: 'R03', 商品名: 'ベッド CCC-3000', '決定借受料(税抜)': '9,000' })
];
const paraRows = [
  { 利用者コード: 'A01', 利用者名: '試験　一号', 利用者カナ: 'シケン　イチゴウ', 拠点: 'Z営業所', 商品名: '手すり  AAA-1000', 型式: 'AAA-1000', 金額: '3,000', 税: '10%' },
  { 利用者コード: 'A02', 利用者名: '試験　二号', 利用者カナ: 'シケン　ニゴウ', 拠点: 'Z営業所', 商品名: '歩行車  BBB-2000', 型式: 'BBB-2000', 金額: '2,000', 税: '10%' },
  { 利用者コード: 'A03', 利用者名: '試験　三号', 利用者カナ: 'シケン　サンゴウ', 拠点: 'W営業所', 商品名: 'ベッド  CCC-3000', 型式: 'CCC-3000', 金額: '9,000', 税: '非' }
];
const RENTA = R(rentaRows);
const RENTA_2MONTHS = R(rentaRows.concat([Object.assign({}, rentaRows[0], { 年度: '2026年7月' })]));
const RENTA_OTHER = R(rentaRows.map(r => Object.assign({}, r, { 年度: '2026年9月' })));
const PARA = P(paraRows);
const PARA_NO_TAX = P(paraRows, PH.filter(h => h !== '税'));

/** アプリ自身が書き出す形の設定 */
const goodCfg = () => ({
  version: 1, savedAt: '2026-09-29T00:00:00.000Z',
  mappings: [
    { bumon: 'X部門', shiireCd: '900', kyoten: ['Z営業所'], ignore: false },
    { bumon: 'V部門', shiireCd: '901', kyoten: [], ignore: true }
  ],
  ignoreKyoten: ['W営業所'], confirmed: [], exclPara: [], exclRenta: [], threshold: 0, showOneSide: true
});

(async () => {
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
    const ui = boot(goodCfg());
    ok(ui.alerts.length === 0, 'アプリが書き出す形の設定はそのまま使える');

    // 画面で操作して保存された設定を、次に開いたときに読み込めること
    const u2 = boot();
    await pick(u2, 'filePara', 'para.csv', PARA);
    await pick(u2, 'fileRenta', 'renta.xls', RENTA);
    await u2.$('btnSuggest').click();
    await cellOf(u2, rowOf(u2, 'V部門', '901'), '対象外').click();
    await u2.$('btnExclCheap').click();
    const saved = u2.store.get('oroshi-checker/v1');
    const u3 = boot(saved);
    ok(u3.alerts.length === 0, '画面で操作して保存された設定は、次に開いたときにそのまま使える');
  }

  console.log('== 設定ファイルを読み込んだら、今のファイルに合わせて整え直す ==');
  {
    const ui = boot();
    await pick(ui, 'filePara', 'para.csv', PARA);
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    const c = goodCfg();
    c.mappings.push({ bumon: 'Q部門', shiireCd: '999', kyoten: ['Z営業所'], ignore: false });
    c.mappings[0].kyoten = ['Z営業所'];
    c.mappings[2].kyoten = ['K営業所'];
    ui.$('fileCfg').value = 'cfg.json';
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(c) }];
    await ui.$('fileCfg').fire('change');
    ok(ui.alerts.length === 0, '（前提）設定ファイルは使える形');
    ok(/今回のファイルに無い組/.test(ui.$('mapMsg').textContent), 'ファイルに無い組は落とし、その旨を出す');
    ok(ui.$('fileCfg').value === '', '同じ設定ファイルを選び直せるよう、選択を空に戻す');
    const bad = goodCfg(); bad.mappings[0].ignore = 'no';
    ui.$('fileCfg').value = 'bad.json';
    ui.$('fileCfg').files = [{ text: async () => JSON.stringify(bad) }];
    await ui.$('fileCfg').fire('change');
    ok(ui.alerts.length === 1 && ui.$('fileCfg').value === '', '使えない設定ファイルでも、選択は空に戻る');
  }

  console.log('== 割り当てと対象外が重なった設定は、割り当てを優先して表示する ==');
  {
    const c = goodCfg(); c.ignoreKyoten = ['W営業所', 'Z営業所'];
    const ui = boot(c);
    await pick(ui, 'filePara', 'para.csv', PARA);
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    ok(ignoreCell(ui, 'Z営業所').checked === false, '割り当て済みの拠点は、対象外のチェックが外れる');
    ok(ignoreCell(ui, 'W営業所').checked === true, '割り当てていない拠点は対象外のまま');
  }

  console.log('== 設定を変えたら、前の結果は使わせない ==');
  {
    const ui = boot(goodCfg());
    await pick(ui, 'filePara', 'para.csv', PARA);
    await pick(ui, 'fileRenta', 'renta.xls', RENTA);
    await ui.$('chkPeriod').click();
    await ui.$('btnRun').click();
    ok(!hidden(ui, 'cardResult'), '（前提）突合すると結果が出る');
    await ui.$('btnXlsx').click();
    const w = ui.written();
    ok(w && w.rows.some(r => /対象外にした卸元の拠点：W営業所/.test(r[0])), '出力の見出しに、対象外にした拠点が出る');
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

  console.log('\n' + (fail ? '!! ' + fail + ' 件失敗' : '全項目 OK'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
