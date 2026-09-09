'use strict';
/* レンタル卸 金額不一致チェッカー — 読み込みと突合のコア
   設計書 DESIGN.md v3.1 に対応。UI を持たない純関数の集まりにして、
   Node からもブラウザからも同じコードを検証できるようにする。 */

// ==================== 正規化（設計書 7.2 / 8.1） ====================

const SPACE_RE = /[\s　]+/g;

function nfkcUpper(s) {
  return String(s == null ? '' : s).normalize('NFKC').toUpperCase();
}

/** 氏名の正規化: NFKC → 括弧書き除去 → 空白除去 → 末尾の記号除去 */
function normName(s) {
  let t = String(s == null ? '' : s).normalize('NFKC');
  t = t.replace(/【.*?】|\(.*?\)|（.*?）/g, '');
  t = t.replace(SPACE_RE, '');
  return t.replace(/[-‐－ー]+$/, '').trim();
}

/** カナの正規化 */
function normKana(s) {
  let t = String(s == null ? '' : s).normalize('NFKC').replace(SPACE_RE, '');
  return t.replace(/[-‐－]+$/, '').trim().normalize('NFC');
}

/** 商品名の正規化: NFKC → 大文字 → 空白と記号を除去 */
function normProduct(s) {
  return nfkcUpper(s).replace(SPACE_RE, '').replace(/[・･.,()（）/\-_]/g, '');
}

/** 型式の正規化: 英数字のみ */
function normModel(s) {
  return nfkcUpper(s).replace(/[^A-Z0-9]/g, '');
}

/** 商品名から英数字トークンを切り出す（空白を残したまま処理するのが要点） */
function productTokens(s) {
  const t = nfkcUpper(s).replace(/[・･.\-_]/g, '');
  return (t.match(/[A-Z0-9]{2,}/g) || []);
}

/** 型式が商品名のトークンと一致するか（単純な部分文字列一致にしない） */
function modelMatches(model, productName) {
  const m = normModel(model);
  if (m.length < 4) return false;
  return productTokens(productName).some(tok => tok === m || tok.startsWith(m));
}

/** 2-gram Dice 係数 */
function similarity(a, b) {
  const A = normProduct(a), B = normProduct(b);
  if (A.length <= 1 || B.length <= 1) return A === B && A.length > 0 ? 1 : 0;
  const sa = new Set(), sb = new Set();
  for (let i = 0; i < A.length - 1; i++) sa.add(A.slice(i, i + 2));
  for (let i = 0; i < B.length - 1; i++) sb.add(B.slice(i, i + 2));
  let inter = 0;
  sa.forEach(g => { if (sb.has(g)) inter++; });
  return (2 * inter) / (sa.size + sb.size);
}

const FACILITY_RE = /特別養護老人ホーム|介護老人保健施設|特養|老健|短期|長期|トクベツヨウゴロウジンホーム|カイゴロウジンホケンシセツ|トクヨウ|ロウケン/g;
function facilityNorm(s) { return String(s || '').replace(FACILITY_RE, ''); }

// ==================== 金額のパース（設計書 5.3） ====================

/** 金額を数値にする。解釈できなければ null（0 にしない） */
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = String(v).normalize('NFKC').trim().replace(/"/g, '').replace(/[,，]/g, '');
  if (s === '') return null;   // 空欄は 0 ではなく「不明」（設計書 5.3）
  if (s === '-' || s === '－' || s === '―') return null;
  let neg = false;
  if (/^[▲△]/.test(s)) { neg = true; s = s.slice(1); }
  else if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  else if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[¥￥円]/g, '').trim();
  if (s === '' || !/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const n = Math.round(Number(s));
  return neg ? -n : n;
}

// ==================== 区切りテキストのパース（設計書 5.1 / 5.3） ====================

/**
 * 引用符つき区切りテキストを行配列にする。
 * 引用符が閉じないまま終端に達したら例外を投げる（部分処理をしない）。
 */
function mkErr(code, message, line) {
  const e = new Error(message + 'ファイルを読み込めません。');
  e.code = code; e.line = line;
  return e;
}

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false, quoteStartLine = 0, line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else {
          inQuotes = false;
          // 閉じ引用符の直後は 区切り・改行・終端 のいずれかでなければならない。
          // 単独の \r（\n を伴わない）も認めない。認めると "a"\rX が aX として読まれてしまう
          const nx = text[i + 1];
          const okNext = nx === undefined || nx === delim || nx === '\n'
            || (nx === '\r' && text[i + 2] === '\n');
          if (!okNext) {
            throw mkErr('BAD_QUOTE', '引用符の閉じ方が正しくありません（' + line + '行目付近）。', line);
          }
        }
      } else {
        // 引用符の中でも単独の CR は認めない（外側と揃える）
        if (c === '\r' && text[i + 1] !== '\n') {
          throw mkErr('BAD_LINEBREAK', '引用符の中の改行の形式が正しくありません（' + line + '行目付近）。', line);
        }
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"') {
      if (field !== '') {
        throw mkErr('BAD_QUOTE', '項目の途中に引用符があります（' + line + '行目付近）。', line);
      }
      inQuotes = true; quoteStartLine = line;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\r') {
      // CRLF の CR だけを読み飛ばす。単独の \r は黙って捨てず構文エラーにする
      if (text[i + 1] !== '\n') {
        throw mkErr('BAD_LINEBREAK', '改行の形式が正しくありません（' + line + '行目付近）。', line);
      }
    } else if (c === '\n') {
      row.push(field); rows.push(row);
      row = []; field = ''; line++;
    } else {
      field += c;
    }
  }
  if (inQuotes) throw mkErr('UNTERMINATED_QUOTE', '引用符が閉じていません（' + quoteStartLine + '行目付近）。', quoteStartLine);
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}

/** ヘッダーと列数が違う行が1つでもあれば、ファイル全体を読込不可にする（設計書 5.3） */
function checkShape(rows, width, label) {
  const bad = [];
  for (let i = 1; i < rows.length && bad.length < 6; i++) {
    const r = rows[i];
    if (r.length !== width && !r.every(x => unquote(x) === '')) bad.push(i + 1 + '行目(' + r.length + '列)');
  }
  if (bad.length) {
    throw mkErr('BAD_SHAPE',
      label + 'の列数がヘッダー(' + width + '列)と違う行があります：' + bad.join('、') +
      '。列がずれたまま突合すると別の列を金額として読んでしまうため、', 0);
  }
}

function unquote(s) {
  const t = String(s == null ? '' : s).trim();
  return t.replace(/^"(.*)"$/s, '$1').trim();
}

// ==================== スマートれん太側の読み込み（設計書 5.1） ====================

const RENTA_REQUIRED = ['年度', '部門名', '仕入先コード', 'お客様番号', 'お客様名',
  '利用者名', '商品', '商品名', '決定借受料(税抜)'];

function loadRenta(text) {
  const rows = parseDelimited(text, '\t');
  if (!rows.length) throw new Error('ファイルが空です。');
  const hdr = rows[0].map(unquote);
  const idx = {};
  hdr.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const missing = RENTA_REQUIRED.filter(k => !(k in idx));
  if (missing.length) {
    throw new Error('支払予定表の列が見つかりません: ' + missing.join('、') +
      '\nスマートれん太の「レンタル卸支払予定表」を Excel 出力したファイルを選んでください。');
  }
  const g = (r, k) => (k in idx ? unquote(r[idx[k]]) : '');
  const out = [];
  checkShape(rows, hdr.length, '支払予定表');
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(x => unquote(x) === '')) continue;
    const amount = parseMoney(g(r, '決定借受料(税抜)'));
    const rec = {
      src: 'renta', lineNo: i + 1,
      period: g(r, '年度'),
      bumon: g(r, '部門名'), bumonCd: g(r, '部門コード'),
      shiireCd: g(r, '仕入先コード'), shiireNm: g(r, '仕入先名'),
      kokyakuNo: g(r, 'お客様番号'), kokyakuNm: g(r, 'お客様名'), kokyakuKana: g(r, 'お客様名ｶﾅ'),
      riyoshaNo: g(r, '取次利用者番号'), riyoshaNm: g(r, '利用者名'), riyoshaKana: g(r, '利用者名ｶﾅ'),
      shohinCd: g(r, '商品'), shohinNm: g(r, '商品名'),
      amount: amount,
      amountRaw: g(r, '決定借受料(税抜)'),
      tax: g(r, '決定卸先消費税区分'),
      days: g(r, '使用日数'), startDate: g(r, '取引開始日'), stopDate: g(r, '取引停止日'),
      kyufu: g(r, '給付方法'), sansho: g(r, '料金参照'), biko: g(r, '備考'),
      payOnly: g(r, '支払のみ発生').trim() !== '' && g(r, '支払のみ発生').trim() !== '　',
      mikakutei: g(r, '未確定').trim()
    };
    rec.name = rec.riyoshaNm || rec.kokyakuNm;
    rec.kana = rec.riyoshaKana || rec.kokyakuKana;
    rec.kName = normName(rec.name);
    rec.kKana = normKana(rec.kana);
    out.push(rec);
  }
  return { rows: out, header: hdr };
}

// ==================== 卸元側の読み込み（設計書 5.2） ====================

const PARA_CSV_REQUIRED = ['利用者名', '金額', '商品名', '拠点'];

function loadParaCsv(text) {
  const rows = parseDelimited(text, ',');
  if (!rows.length) throw new Error('ファイルが空です。');
  const hdr = rows[0].map(unquote);
  const idx = {};
  hdr.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const missing = PARA_CSV_REQUIRED.filter(k => !(k in idx));
  if (missing.length) {
    throw new Error('請求データの列が見つかりません: ' + missing.join('、'));
  }
  const g = (r, k) => (k in idx ? unquote(r[idx[k]]) : '');
  const out = [];
  checkShape(rows, hdr.length, '請求データ');
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(x => unquote(x) === '')) continue;
    out.push(makeParaRec({
      lineNo: i + 1,
      riyoshaCd: g(r, '利用者コード'), riyoshaNm: g(r, '利用者名'), riyoshaKana: g(r, '利用者カナ'),
      mark: g(r, 'マーク'), kubun: g(r, '区分'), denpyoNo: g(r, '伝票No'), kyoten: g(r, '拠点'),
      shohinCd: g(r, '商品コード'), shohinNm: g(r, '商品名'), model: g(r, '型式'),
      startDate: g(r, '開始日'), endDate: g(r, '終了日'),
      chudanDate: g(r, '中断日'), saikaiDate: g(r, '再開日'),
      qty: g(r, '数量'), unit: g(r, '単位'), amountRaw: g(r, '金額'), tax: g(r, '税')
    }));
  }
  return { rows: out, header: hdr, hasKyoten: true, hasCode: ('利用者コード' in idx) };
}

/** 旧 xlsx 形式（10列・ヘッダー行がデータに紛れる・拠点なし） */
function loadParaXlsxRows(sheets) {
  const out = [];
  sheets.forEach(sheet => {
    sheet.rows.forEach((r, i) => {
      if (r[0] == null || String(r[0]).trim() === '') return;
      if (String(r[0]).trim() === '利用者名' && String(r[1]).trim() === '金額') return;
      out.push(makeParaRec({
        lineNo: i + 1, sheet: sheet.name,
        riyoshaCd: '', riyoshaNm: String(r[0] || ''), riyoshaKana: String(r[2] || ''),
        mark: '', kubun: '', denpyoNo: '', kyoten: '',
        shohinCd: String(r[3] || ''), shohinNm: String(r[4] || ''), model: String(r[5] || ''),
        startDate: r[6] == null ? '' : String(r[6]), endDate: '', chudanDate: '', saikaiDate: '',
        qty: String(r[7] || ''), unit: String(r[8] || ''), amountRaw: r[1], tax: String(r[9] || '')
      }));
    });
  });
  return { rows: out, hasKyoten: false, hasCode: false };
}

const MARK_NAME = { '○': '新規', '●': '解約', '▲': '中断', '□': '差分' };

function makeParaRec(o) {
  const rec = Object.assign({ src: 'para' }, o);
  rec.amount = parseMoney(o.amountRaw);
  rec.markName = MARK_NAME[String(o.mark || '').trim()] || '';
  rec.kName = normName(rec.riyoshaNm);
  rec.kKana = normKana(rec.riyoshaKana);
  return rec;
}

// ==================== 突合範囲（設計書 6） ====================

/** 対応表: [{ bumon, shiireCd, kyoten: [..] }] */
function applyScope(rentaRows, paraRows, mappings) {
  const live = mappings.filter(m => !m.ignore);
  const skip = mappings.filter(m => m.ignore);
  const rentaKeys = new Set(live.map(m => m.bumon + '\t' + m.shiireCd));
  // 「対象外」と明示された組は範囲外に入るが、未解決としては数えない
  const ignoredKeys = new Set(skip.map(m => m.bumon + '\t' + m.shiireCd));
  const kyotenSet = new Set();
  live.forEach(m => (m.kyoten || []).forEach(k => kyotenSet.add(k)));
  const ignoredKyoten = new Set();
  skip.forEach(m => (m.kyoten || []).forEach(k => ignoredKyoten.add(k)));
  // 対応表の組ごとにスコープIDを振る。名寄せは同じスコープの中だけで行う（設計書 6）
  const scopeOfRenta = new Map();
  const scopeOfKyoten = new Map();
  const dupKyoten = [];
  live.forEach((m, i) => {
    scopeOfRenta.set(m.bumon + '\t' + m.shiireCd, i);
    (m.kyoten || []).forEach(k => {
      if (scopeOfKyoten.has(k)) dupKyoten.push(k);
      scopeOfKyoten.set(k, i);
    });
  });
  rentaRows.forEach(r => {
    const key = r.bumon + '\t' + r.shiireCd;
    r.inScope = rentaKeys.has(key);
    r.declaredOut = ignoredKeys.has(key);
    r.scopeId = r.inScope ? scopeOfRenta.get(key) : null;
  });
  paraRows.forEach(p => {
    // 拠点列が無い旧形式は範囲判定ができないため全件を範囲内として扱う（画面で警告する）
    if (!p.kyoten) {
      p.inScope = true; p.declaredOut = false;
      p.scopeId = live.length === 1 ? 0 : -1;   // 組が1つなら確定、複数なら判定不能
    } else {
      p.inScope = kyotenSet.has(p.kyoten);
      p.declaredOut = ignoredKyoten.has(p.kyoten);
      p.scopeId = p.inScope ? scopeOfKyoten.get(p.kyoten) : null;
    }
  });
  return { rentaKeys, kyotenSet, ignoredKeys, dupKyoten: [...new Set(dupKyoten)] };
}

/** ファイル内に存在する組を列挙して、対応表の登録候補にする */
function discoverGroups(rentaRows, paraRows) {
  const rm = new Map(), pk = new Map();
  rentaRows.forEach(r => {
    const k = r.bumon + '\t' + r.shiireCd;
    if (!rm.has(k)) rm.set(k, { bumon: r.bumon, shiireCd: r.shiireCd, shiireNm: r.shiireNm, count: 0, amount: 0 });
    const e = rm.get(k); e.count++; e.amount += (r.amount || 0);
  });
  paraRows.forEach(p => {
    const k = p.kyoten || '(拠点なし)';
    if (!pk.has(k)) pk.set(k, { kyoten: k, count: 0, amount: 0 });
    const e = pk.get(k); e.count++; e.amount += (p.amount || 0);
  });
  return { rentaGroups: [...rm.values()], paraKyoten: [...pk.values()] };
}

const __core = {
  normName, normKana, normProduct, normModel, productTokens, modelMatches,
  similarity, facilityNorm, parseMoney, parseDelimited, unquote,
  loadRenta, loadParaCsv, loadParaXlsxRows, applyScope, discoverGroups, MARK_NAME
};
if (typeof module !== 'undefined' && module.exports) module.exports = __core;
if (typeof window !== 'undefined') window.AppCore = __core;
