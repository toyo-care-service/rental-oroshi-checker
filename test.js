'use strict';
/* 合成データによる自動テスト。実データは使わない（実データ検証は verify.local.js）。
   実行: node test.js */
const C = require('./app.core.js');
const M = require('./app.match.js');

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? '  OK   ' : '  NG   ') + msg);
  if (!cond) fail++;
}

// ==================== 正規化と類似度 ====================
console.log('== 正規化・型式の一致判定 ==');
ok(C.modelMatches('ABC-BH', '部品台H ABC-BH 用'),
  '空白の直前に英字があっても型式が正しく一致する');
ok(!C.modelMatches('ABC-BH', '部品台H ABC-BL 用'),
  '1文字違いの型式は一致しない');
ok(!C.modelMatches('AT-C', 'ｱｯﾄｸﾞﾘｯﾌﾟ AT-C-240'),
  '4文字未満の型式は根拠に使わない');
ok(C.modelMatches('KZ-325001', '歩行車 KZ-325001'), '通常の型式一致');
ok(C.similarity('歩行車 コンテ KZ-325001', '歩行車 ｺﾝﾃ KZ-325001') > 0.45,
  '全角と半角カナの表記ゆれでも類似度が閾値を超える');
ok(C.similarity('車いす', 'ベッド用手すり') < 0.45, '別商品の類似度は閾値未満');

console.log('== 金額のパース ==');
ok(C.parseMoney('13,000') === 13000, 'カンマ区切り');
ok(C.parseMoney('▲2,200') === -2200, '▲ による負数');
ok(C.parseMoney('(1,000)') === -1000, '括弧による負数');
ok(C.parseMoney('１２３') === 123, '全角数字');
ok(C.parseMoney('¥500') === 500, '円記号つき');
ok(C.parseMoney('') === null, '空欄は「不明」（0にしない）');
ok(C.parseMoney('-') === null, 'ハイフン単独は「不明」（0 にしない）');
ok(C.parseMoney('未定') === null, '解釈できない値は「不明」');

console.log('== 区切りテキストのパース ==');
const q = C.parseDelimited('a\tb\n"改行\n入り"\tc\n', '\t');
ok(q.length === 2 && q[1][0] === '改行\n入り', '引用符の中の改行を1フィールドとして読む');
let threw = false;
try { C.parseDelimited('a\tb\n"閉じない\tc', '\t'); }
catch (e) { threw = (e.code === 'UNTERMINATED_QUOTE'); }
ok(threw, '引用符が閉じないファイルは例外を投げて止まる');

// ==================== 合成データ ====================
const RH = ['年度', '部門コード', '部門名', '仕入先コード', '仕入先名', 'お客様番号', 'お客様名', 'お客様名ｶﾅ',
  '取次利用者番号', '利用者名', '利用者名ｶﾅ', '商品', '商品名', '利用者料金', '卸先料金', '決定卸先料金',
  '決定借受料(税抜)', '決定卸先消費税', '決定卸先消費税区分', '使用日数', '取引開始日', '取引停止日',
  '給付方法', '料金分類', '料金参照', '納品書番号', '中止理由', '備考', '支払のみ発生', '未確定'];
const rrow = o => RH.map(h => (o[h] == null ? '' : String(o[h]))).join('\t');
const R = (rows) => [RH.join('\t')].concat(rows.map(rrow)).join('\r\n');

const PH = ['請求先名', '得意先名', '利用者コード', '利用者名', '利用者カナ', 'マーク', '区分', '伝票No',
  '拠点', '商品コード', '商品名', '型式', '開始日', '終了日', '中断日', '再開日', '数量', '単位', '金額', '税'];
const qq = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const prow = o => PH.map(h => qq(o[h] == null ? '' : o[h])).join(',');
const P = (rows) => [PH.map(qq).join(',')].concat(rows.map(prow)).join('\r\n');

const base = { 年度: '2026年8月', 部門コード: '1', 部門名: 'X部門', 仕入先コード: '900', 仕入先名: 'Y卸元' };

const rentaText = R([
  // 同一カナの別人（シケン イチゴウ）。分離できることを確かめる
  Object.assign({}, base, { お客様番号: '1001', 利用者名: '試験 一号', 利用者名ｶﾅ: 'ｼｹﾝ ｲﾁｺﾞｳ', 商品: 'R01', 商品名: '手すり AAA-1000', '決定借受料(税抜)': '4,000', 取引開始日: '2024/01/10' }),
  Object.assign({}, base, { お客様番号: '1002', 利用者名: '試験 壱号', 利用者名ｶﾅ: 'ｼｹﾝ ｲﾁｺﾞｳ', 商品: 'R02', 商品名: '歩行車 BBB-2000', '決定借受料(税抜)': '2,000', 取引開始日: '2024/02/20' }),
  // 卸元側でコードが2つに分かれている人（合算されるはず）
  Object.assign({}, base, { お客様番号: '1003', 利用者名: '試験 三号', 利用者名ｶﾅ: 'ｼｹﾝ ｻﾝｺﾞｳ', 商品: 'R03', 商品名: 'ベッド CCC-3000', '決定借受料(税抜)': '5,000', 取引開始日: '2025/05/05' }),
  Object.assign({}, base, { お客様番号: '1003', 利用者名: '試験 三号', 利用者名ｶﾅ: 'ｼｹﾝ ｻﾝｺﾞｳ', 商品: 'R04', 商品名: 'テーブル DDD-4000', '決定借受料(税抜)': '1,000', 取引開始日: '2025/05/05' }),
  // 除外対象（1円の付属品）
  Object.assign({}, base, { お客様番号: '1001', 利用者名: '試験 一号', 利用者名ｶﾅ: 'ｼｹﾝ ｲﾁｺﾞｳ', 商品: 'R05', 商品名: '付属品 ZZZ-9', '決定借受料(税抜)': '0', 取引開始日: '2024/01/10' }),
  // 範囲外（別の仕入先）
  Object.assign({}, base, { 部門名: 'W部門', 仕入先コード: '999', 仕入先名: '別の卸元', お客様番号: '2001', 利用者名: '範囲外 太郎', 利用者名ｶﾅ: 'ﾊﾝｲｶﾞｲ ﾀﾛｳ', 商品: 'R99', 商品名: '対象外の商品', '決定借受料(税抜)': '77,777' })
]);

const paraText = P([
  { 利用者コード: 'A01', 利用者名: '試験　一号', 利用者カナ: 'シケン　イチゴウ', 区分: 'レンタル', 伝票No: 'D1', 拠点: 'Z営業所', 商品コード: 'P01', 商品名: '手すり  AAA-1000', 型式: 'AAA-1000', 開始日: '24/01/10', 数量: '1', 単位: '台', 金額: '3,000', 税: '10%' },
  { 利用者コード: 'A02', 利用者名: '試験　壱号', 利用者カナ: 'シケン　イチゴウ', 区分: 'レンタル', 伝票No: 'D2', 拠点: 'Z営業所', 商品コード: 'P02', 商品名: '歩行車  BBB-2000', 型式: 'BBB-2000', 開始日: '24/02/20', 数量: '1', 単位: '台', 金額: '2,000', 税: '10%' },
  { 利用者コード: 'A03', 利用者名: '試験　三号', 利用者カナ: 'シケン　サンゴウ', 区分: 'レンタル', 伝票No: 'D3', 拠点: 'Z営業所', 商品コード: 'P03', 商品名: 'ベッド  CCC-3000', 型式: 'CCC-3000', 開始日: '25/05/05', 数量: '1', 単位: '台', 金額: '5,000', 税: '非' },
  { 利用者コード: 'A04', 利用者名: '試験　参号', 利用者カナ: 'シケン　サンゴウ', 区分: 'レンタル', 伝票No: 'D4', 拠点: 'Z営業所', 商品コード: 'P04', 商品名: 'テーブル  DDD-4000', 型式: 'DDD-4000', 開始日: '25/05/05', 数量: '1', 単位: '台', 金額: '1,000', 税: '10%' },
  { 利用者コード: 'A01', 利用者名: '試験　一号', 利用者カナ: 'シケン　イチゴウ', 区分: 'レンタル', 伝票No: 'D1', 拠点: 'Z営業所', 商品コード: 'P05', 商品名: '付属品  ZZZ-9', 型式: 'ZZZ-9', 開始日: '24/01/10', 数量: '1', 単位: '台', 金額: '1', 税: '10%' },
  { 利用者コード: 'A09', 利用者名: '卸元のみ　九号', 利用者カナ: 'オロシモトノミ　キュウゴウ', マーク: '○', 区分: 'レンタル', 伝票No: 'D9', 拠点: 'Z営業所', 商品コード: 'P09', 商品名: '車いす  EEE-5000', 型式: '-', 開始日: '26/08/01', 数量: '1', 単位: '台', 金額: '6,000', 税: '非' }
]);

console.log('== 読み込み ==');
const renta = C.loadRenta(rentaText);
const para = C.loadParaCsv(paraText);
ok(renta.rows.length === 6, '支払予定表 6行');
ok(para.rows.length === 6, '請求データ 6行');
ok(renta.rows.every(r => r.amount !== null) && para.rows.every(p => p.amount !== null), '金額をすべて解釈できる');

console.log('== 対応表の自動提案 ==');
const sug = M.suggestMappings(renta.rows, para.rows);
const hit = sug.groups.find(g => g.shiireCd === '900');
const other = sug.groups.find(g => g.shiireCd === '999');
ok(hit && hit.suggestKyoten.includes('Z営業所'), '利用者が重なる組に拠点を提案する');
ok(other && other.suggestIgnore, '利用者が重ならない組は「対象外」を提案する');

console.log('== 突合 ==');
const mappings = [
  { bumon: 'X部門', shiireCd: '900', kyoten: ['Z営業所'], ignore: false },
  { bumon: 'W部門', shiireCd: '999', kyoten: [], ignore: true }
];
const exclP = [{ field: 'model', value: 'ZZZ-9', amountIn: [0, 1] }];
const exclR = [{ field: 'shohinNm', value: 'ZZZ-9', amountIn: [0, 1] }];
renta.rows.forEach(r => { r.bucket = null; });
para.rows.forEach(p => { p.bucket = null; });
const res = M.reconcile(para.rows, renta.rows, {
  mappings, confirmed: [], excludeParaRules: exclP, excludeRentaRules: exclR
});
const B = M.BUCKET;

ok(res.checksum.ok, '検算が成立する');
const all = new Set(Object.values(B));
ok(para.rows.every(p => all.has(p.bucket)), '請求データの全行がバケットに入る');
ok(renta.rows.every(r => all.has(r.bucket)), '支払予定表の全行がバケットに入る');
ok(res.buckets[B.OUTSCOPE].renta.amount === 77777, '対象外にした組は範囲外に入る');
ok(res.unresolved.outscope === 0, '「対象外」と明示した組は未解決として数えない');
ok(res.buckets[B.EXCLUDED].para.count === 1 && res.buckets[B.EXCLUDED].renta.count === 1,
  '除外条件が両側に効く');

const find = nm => res.persons.filter(v => v.label.replace(/[\s　]/g, '') === nm);
ok(find('試験一号').length === 1 && find('試験壱号').length === 1,
  '同一カナの別人が分離される');
ok(find('試験一号')[0].diff === 1000, '試験一号の差額は +1,000円');
ok(find('試験壱号')[0].diff === 0, '試験壱号は一致');
const sango = find('試験三号');
ok(sango.length === 1 && sango[0].flags.includes('合算') && sango[0].para.length === 2,
  '卸元側でコードが分かれている人が合算され、フラグが立つ');
ok(sango[0].diff === 0, '合算した結果は一致');
const only = res.persons.filter(v => v.para.length && !v.renta.length);
ok(only.length === 1 && only[0].diff === -6000, '卸元にしか無い人が残る');

ok(!res.canSayNoDiff, '判定不能が残るので「不一致なし」とは言わない');
const weak = res.persons.filter(v => M.TIER_FLAG[v.tier]);
ok(weak.every(v => v.flags.some(f => f.indexOf('根拠:') === 0)),
  '弱い根拠で結んだ人には必ずフラグが付く');

console.log('== 数式インジェクション対策 ==');
const RISKY = /^[=+\-@\t\r]/;
const safe = s => (RISKY.test(String(s)) ? "'" + s : String(s));
ok(safe('=1+1') === "'=1+1" && safe('-3,000') === "'-3,000" && safe('普通') === '普通',
  '先頭が = + - @ の文字列だけエスケープする');


// ==================== 本番前レビューで直した点の確認 ====================
console.log('\n== 対応表の組（スコープ）をまたいで名寄せしない ==');
{
  const rt = R([
    Object.assign({}, base, { お客様番号: '3001', 利用者名: '同名 太郎', 利用者名ｶﾅ: 'ﾄﾞｳﾒｲ ﾀﾛｳ', 商品: 'S1', 商品名: '品目 FFF-6000', '決定借受料(税抜)': '1,000' }),
    Object.assign({}, base, { 部門名: 'V部門', 仕入先コード: '901', お客様番号: '3002', 利用者名: '同名 太郎', 利用者名ｶﾅ: 'ﾄﾞｳﾒｲ ﾀﾛｳ', 商品: 'S2', 商品名: '品目 GGG-7000', '決定借受料(税抜)': '2,000' })
  ]);
  const pt = P([
    { 利用者コード: 'B01', 利用者名: '同名　太郎', 利用者カナ: 'ドウメイ　タロウ', 区分: 'レンタル', 伝票No: 'E1', 拠点: 'Z営業所', 商品コード: 'Q1', 商品名: '品目  FFF-6000', 型式: 'FFF-6000', 数量: '1', 単位: '台', 金額: '1,000', 税: '10%' },
    { 利用者コード: 'B02', 利用者名: '同名　太郎', 利用者カナ: 'ドウメイ　タロウ', 区分: 'レンタル', 伝票No: 'E2', 拠点: 'W営業所', 商品コード: 'Q2', 商品名: '品目  GGG-7000', 型式: 'GGG-7000', 数量: '1', 単位: '台', 金額: '2,000', 税: '10%' }
  ]);
  const r2 = C.loadRenta(rt), p2 = C.loadParaCsv(pt);
  r2.rows.forEach(x => { x.bucket = null; }); p2.rows.forEach(x => { x.bucket = null; });
  const res2 = M.reconcile(p2.rows, r2.rows, {
    mappings: [
      { bumon: 'X部門', shiireCd: '900', kyoten: ['Z営業所'], ignore: false },
      { bumon: 'V部門', shiireCd: '901', kyoten: ['W営業所'], ignore: false }
    ], confirmed: [], excludeParaRules: [], excludeRentaRules: []
  });
  const doumei = res2.persons.filter(v => v.label.replace(/[\s　]/g, '') === '同名太郎');
  ok(doumei.length === 2, '同名の利用者が、組ごとに別人として扱われる');
  ok(doumei.every(v => v.diff === 0), '組ごとに正しい相手と突合できている');
  ok(res2.checksum.ok, 'スコープを分けても検算が成立する');
}

console.log('== 壊れた入力はファイル全体を読込不可にする ==');
{
  let e1 = null;
  try { C.loadRenta(R([Object.assign({}, base, { お客様番号: '1', 利用者名: 'あ', 商品: 'X', 商品名: 'Y', '決定借受料(税抜)': '1' })]) + '\r\n列が足りない\t行'); }
  catch (e) { e1 = e.code; }
  ok(e1 === 'BAD_SHAPE', '列数がヘッダーと違えば読込不可にする');
  let e2 = null;
  try { C.parseDelimited('a\tb\nあ"い\tc\n', '\t'); } catch (e) { e2 = e.code; }
  ok(e2 === 'BAD_QUOTE', '項目の途中の引用符を構文エラーにする');
  let e3 = null;
  try { C.parseDelimited('a\tb\n"あ"い\tc\n', '\t'); } catch (e) { e3 = e.code; }
  ok(e3 === 'BAD_QUOTE', '閉じ引用符の直後に文字があれば構文エラーにする');
}

console.log('\n' + (fail ? '!! ' + fail + ' 件失敗' : '全項目 OK'));
process.exit(fail ? 1 : 0);
