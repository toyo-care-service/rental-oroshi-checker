'use strict';
/* レンタル卸 金額不一致チェッカー — 画面まわり
   描画は textContent のみ。入力ファイルは社外由来のため innerHTML を使わない。 */

(function () {
  const C = window.AppCore, M = window.AppMatch, X = window.AppXlsx;
  const $ = id => document.getElementById(id);
  const STORE_KEY = 'oroshi-checker/v1';

  const S = {
    renta: null, para: null, rentaName: '', paraName: '',
    period: '', suggest: null, bumon: null, mappings: [], ignoreKyoten: [], ignoreByBumon: {}, confirmed: [], dupKyoten: [],
    exclPara: [], exclRenta: [], result: null
  };

  // ---------- 小道具 ----------
  const yen = n => (n == null ? '' : n.toLocaleString('ja-JP'));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  };
  function msg(box, kind, text) {
    const d = el('div', 'msg ' + kind, text);
    box.appendChild(d);
    return d;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  // ---------- 設定の保存（設計書 11） ----------
  const CFG_VERSION = 1;
  function cfgObject() {
    // 対象外にした卸元の拠点は、拠点（部門）ごとに持つ。同じ卸元の拠点でも、選ぶ拠点によって突合する・しないが変わるため
    if (S.bumon != null) S.ignoreByBumon[S.bumon] = S.ignoreKyoten;
    return {
      version: CFG_VERSION, savedAt: new Date().toISOString(),
      bumon: S.bumon, mappings: S.mappings, ignoreKyotenByBumon: S.ignoreByBumon, confirmed: S.confirmed,
      exclPara: S.exclPara, exclRenta: S.exclRenta,
      threshold: Number($('threshold').value) || 0,
      showOneSide: $('chkOneSide').checked
    };
  }
  // 設定はアプリ自身が書き出す形だけを受け付ける（手で書き換えた・壊れた設定で画面と集計がずれないように）
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string' && v !== '';
  function validCfg(o) {
    if (!isObj(o)) return '設定の形式が正しくありません';
    if (o.version !== CFG_VERSION) return '設定のバージョンが違います（' + o.version + '）';
    if (!Array.isArray(o.mappings)) return '対応表がありません';
    for (const k of ['confirmed', 'exclPara', 'exclRenta', 'ignoreKyoten']) {
      if (o[k] != null && !Array.isArray(o[k])) return k + ' の形式が正しくありません';
    }
    for (const m of o.mappings) {
      if (!isObj(m) || typeof m.bumon !== 'string' || typeof m.shiireCd !== 'string') return '対応表の中身が正しくありません';
      if (typeof m.ignore !== 'boolean' || !Array.isArray(m.kyoten) || !m.kyoten.every(isStr)) return '対応表の拠点が正しくありません';
      if (m.ignore && m.kyoten.length) return '対象外の組に拠点が入っています';
      if (!m.ignore && !m.kyoten.length) return '突合する拠点が指定されていない組があります';
    }
    if (!(o.ignoreKyoten || []).every(isStr)) return '対象外の拠点が正しくありません';
    if (o.bumon != null && typeof o.bumon !== 'string') return '拠点の指定が正しくありません';
    if (o.ignoreKyotenByBumon != null) {
      if (!isObj(o.ignoreKyotenByBumon)) return '対象外の拠点が正しくありません';
      for (const b of Object.keys(o.ignoreKyotenByBumon)) {
        const v = o.ignoreKyotenByBumon[b];
        if (!Array.isArray(v) || !v.every(isStr)) return '対象外の拠点が正しくありません';
      }
    }
    for (const c of (o.confirmed || [])) {
      if (!isObj(c) || !isStr(c.paraKey) || !isStr(c.rentaKey)) return '確認済み対応表の中身が正しくありません';
      if (['paraDisp', 'rentaDisp', 'at'].some(k => c[k] != null && typeof c[k] !== 'string')) return '確認済み対応表の中身が正しくありません';
    }
    const seen = new Set();
    for (const c of (o.confirmed || [])) {
      if (seen.has(c.paraKey)) return '確認済み対応表に同じ相手が2回出てきます';
      seen.add(c.paraKey);
    }
    for (const k of ['exclPara', 'exclRenta']) {
      for (const r of (o[k] || [])) {
        if (!isObj(r) || ['model', 'shohinNm', 'shohinCd'].indexOf(r.field) < 0) return k + ' の条件の種類が不正です';
        if (typeof r.value !== 'string') return k + ' の条件の値が不正です';
        if (r.amountIn != null && (!Array.isArray(r.amountIn) || r.amountIn.some(n => typeof n !== 'number' || !isFinite(n)))) {
          return k + ' の金額条件が不正です';
        }
      }
    }
    if (o.threshold != null && (typeof o.threshold !== 'number' || !isFinite(o.threshold) || o.threshold < 0)) {
      return 'しきい値が不正です';
    }
    if (o.showOneSide != null && typeof o.showOneSide !== 'boolean') return '表示の切替が正しくありません';
    const mkeys = new Set();
    for (const m of o.mappings) {
      const k = m.bumon + '\t' + m.shiireCd;
      if (mkeys.has(k)) return '対応表に同じ組が2回出てきます';
      mkeys.add(k);
    }
    return null;
  }
  function saveCfg() {
    if (!$('chkSave').checked) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfgObject())); } catch (e) { /* 保存できなくても処理は続ける */ }
  }
  function loadCfg() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    let o;
    try { o = JSON.parse(raw); } catch (e) { alert('保存されていた設定を読み込めませんでした。設定はやり直しになります。'); return; }
    const bad = validCfg(o);
    if (bad) { alert('保存されていた設定が使えません（' + bad + '）。設定はやり直しになります。'); return; }
    applyCfg(o);
  }
  function applyCfg(o) {
    S.mappings = o.mappings || [];
    // 拠点（部門）を選ぶ前の版が書いた ignoreKyoten は、どの拠点のものか分からないので使わない
    S.ignoreByBumon = {};
    Object.keys(o.ignoreKyotenByBumon || {}).forEach(b => { S.ignoreByBumon[b] = o.ignoreKyotenByBumon[b].slice(); });
    S.bumon = typeof o.bumon === 'string' ? o.bumon : null;
    loadIgnoreFor(S.bumon);
    S.confirmed = o.confirmed || [];
    S.exclPara = o.exclPara || [];
    S.exclRenta = o.exclRenta || [];
    $('threshold').value = o.threshold || 0;
    $('chkOneSide').checked = o.showOneSide !== false;
    renderExcl();
  }
  /** 選んだ拠点の「対象外にした卸元の拠点」を取り出す。組に割り当てた拠点は対象外より優先する（集計側と同じ） */
  function loadIgnoreFor(b) {
    const assigned = new Set();
    S.mappings.filter(m => m.bumon === b && !m.ignore).forEach(m => m.kyoten.forEach(k => assigned.add(k)));
    S.ignoreKyoten = (b != null && S.ignoreByBumon[b] ? S.ignoreByBumon[b] : []).filter(k => !assigned.has(k));
  }

  // ---------- ファイル読み込み ----------
  function readAsText(file) {
    return file.arrayBuffer().then(buf => {
      const bytes = new Uint8Array(buf);
      // UTF-8 BOM があれば UTF-8、無ければ Shift_JIS として読む
      try {
        if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
        }
        return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
      } catch (e) {
        throw new Error('文字コードを解釈できないバイト列が含まれています。'
          + 'ファイルが壊れているか、想定と違う文字コードで保存されています。');
      }
    });
  }

  /** 設定を変えたら前の結果は使わせない。出力の見出し（今の設定）と中身（前の結果）が食い違うため、突合し直してもらう */
  function invalidateResult() {
    if (!S.result) return;
    S.result = null;
    show('cardResult', false);
  }

  /** ファイルが変わったら、前のファイルに紐づく候補・確認・結果を捨てる（設計書 6） */
  function resetScope() {
    S.suggest = null;
    S.result = null;
    $('chkPeriod').checked = false;
    show('cardResult', false);
    const tb = $('mapTable').querySelector('tbody');
    if (tb) clear(tb);
  }

  function hookDrop(dropId, inputId, handler) {
    const drop = $(dropId), input = $(inputId);
    const pick = () => input.click();
    drop.addEventListener('click', pick);
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => { if (input.files[0]) handler(input.files[0]); });
  }

  function markDone(dropId, fnId, name, sub) {
    $(dropId).classList.add('done');
    $(fnId).textContent = name + (sub ? '　' + sub : '');
  }

  // 同じ種類のファイルを続けて選んだとき、後から読み終わった古い方で上書きしないよう、最新の読込だけを採用する
  const loadSeq = { renta: 0, para: 0 };
  // 読み込み中は突合させない。選んだ瞬間に前の結果も隠す（読み終わる前に前の結果を出力させない）
  const loading = { renta: false, para: false };
  function startLoading(kind) {
    loading[kind] = true;
    invalidateResult();
    refresh();
  }

  /** 読めなかったファイルは、前に読んだファイルごと未読込に戻す（表示と状態をそろえる） */
  function failRenta(message) {
    S.renta = null; S.rentaName = ''; S.period = '';
    msg($('loadMsgRenta'), 'warn', message);
    $('dropRenta').classList.remove('done'); $('fnRenta').textContent = '';
  }
  function failPara(message) {
    S.para = null; S.paraName = '';
    msg($('loadMsgPara'), 'warn', message);
    $('dropPara').classList.remove('done'); $('fnPara').textContent = '';
  }

  async function onRenta(file) {
    const seq = ++loadSeq.renta;
    startLoading('renta');
    let r = null, err = null;
    try { r = C.loadRenta(await readAsText(file)); } catch (e) { err = e; }
    if (seq !== loadSeq.renta) return;
    loading.renta = false;
    clear($('loadMsgRenta'));
    if (err) {
      failRenta('支払予定表を読み込めませんでした。' + err.message);
    } else if (!r.rows.length) {
      failRenta('支払予定表にデータが1行もありません。年月の入れ間違いがないか確かめて、出力し直してください。');
    } else {
      const periods = [...new Set(r.rows.map(x => x.period).filter(Boolean))];
      if (periods.length !== 1) {
        failRenta('支払予定表に年月が' + periods.length + '種類入っています（' +
          periods.join('、') + '）。1か月分だけを出力し直してください。');
      } else {
        S.renta = r; S.rentaName = file.name; S.period = periods[0];
        resetScope();
        markDone('dropRenta', 'fnRenta', file.name, r.rows.length.toLocaleString() + '行・' + S.period);
      }
    }
    refresh();
  }

  async function onPara(file) {
    const seq = ++loadSeq.para;
    startLoading('para');
    const isXlsx = /\.xlsx?$/i.test(file.name) && !/\.csv$/i.test(file.name);
    let p = null, err = null;
    try {
      if (isXlsx) {
        const buf = await file.arrayBuffer();
        if (seq !== loadSeq.para) return;
        const wb = XLSX.read(buf, { type: 'array' });
        const sheets = wb.SheetNames.map(n => ({
          name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })
        }));
        p = C.loadParaXlsxRows(sheets);
      } else {
        p = C.loadParaCsv(await readAsText(file));
      }
    } catch (e) { err = e; }
    if (seq !== loadSeq.para) return;
    loading.para = false;
    clear($('loadMsgPara'));
    if (err) {
      failPara('請求データを読み込めませんでした。' + err.message);
    } else if (!p.rows.length) {
      failPara('請求データにデータが1行もありません。届いたファイルの中身を確かめてください。');
    } else {
      S.para = p; S.paraName = file.name;
      resetScope();
      const total = p.rows.reduce((s, x) => s + (x.amount || 0), 0);
      markDone('dropPara', 'fnPara', file.name, p.rows.length.toLocaleString() + '行・合計 ' + yen(total) + '円');
      if (isXlsx) {
        msg($('loadMsgPara'), 'note', 'xlsx 形式には拠点・利用者コード・マークの列がありません。' +
          '突合する範囲の確認と名寄せの精度が落ちます。可能であれば CSV をもらってください。');
      }
      const bad = p.rows.filter(x => x.amount == null).length;
      if (bad) msg($('loadMsgPara'), 'warn', '金額を読み取れない行が ' + bad + ' 行あります。検算ができないため、結果は確定扱いになりません。');
    }
    refresh();
  }

  // ---------- 拠点（部門）の選択 ----------
  // 突合は拠点（スマートれん太の部門）を1つ選んで行う。選んでいない拠点の行は、すべて対象外として扱う
  function renderBumon() {
    const box = $('bumonPick'); clear(box);
    const count = new Map();
    S.renta.rows.forEach(r => count.set(r.bumon, (count.get(r.bumon) || 0) + 1));
    const names = [...count.keys()];
    // 保存してある拠点が今月のファイルに無ければ選び直してもらう。1つしか無ければそれを選ぶ
    if (!names.includes(S.bumon)) switchBumon(names.length === 1 ? names[0] : null);
    names.forEach(name => {
      const lab = el('label', 'pick');
      const rb = document.createElement('input');
      rb.type = 'radio'; rb.name = 'bumon'; rb.checked = name === S.bumon;
      rb.addEventListener('change', () => { if (rb.checked) selectBumon(name); });
      lab.appendChild(rb);
      lab.appendChild(el('span', null, (name || '（部門なし）') + '　' + count.get(name).toLocaleString() + '行'));
      box.appendChild(lab);
    });
  }
  function switchBumon(name) {
    if (S.bumon != null) S.ignoreByBumon[S.bumon] = S.ignoreKyoten;
    S.bumon = name;
    loadIgnoreFor(name);
  }
  function selectBumon(name) {
    switchBumon(name);
    invalidateResult(); saveCfg(); renderMap(); refresh();
  }

  // ---------- 対応表 ----------
  function renderMap() {
    if (!S.renta || !S.para) return;
    if (!S.suggest) S.suggest = M.suggestMappings(S.renta.rows, S.para.rows);
    renderBumon();
    if (S.bumon == null) {
      clear($('mapTable').querySelector('thead')); clear($('mapTable').querySelector('tbody'));
      S.dupKyoten = [];
      const box = $('mapMsg'); clear(box);
      msg(box, 'note', '拠点を選んでください。選んだ拠点の分だけを突合します。');
      return;
    }
    const kyoten = S.suggest.kyoten.map(k => k.kyoten);
    const presentK = new Set(kyoten);
    const thead = $('mapTable').querySelector('thead');
    const tbody = $('mapTable').querySelector('tbody');
    clear(thead); clear(tbody);

    const tr = el('tr');
    ['部門', '仕入先コード', '仕入先名', '行数', '金額'].forEach((h, i) => {
      const th = el('th', i >= 3 ? 'num' : null, h); tr.appendChild(th);
    });
    kyoten.forEach(k => tr.appendChild(el('th', null, k)));
    tr.appendChild(el('th', null, '対象外'));
    thead.appendChild(tr);

    // 卸元側の拠点を対象外にする行。組を対象外にするだけでは卸元側の行が範囲外（未解決）に残るため
    const igRow = el('tr', 'ignore-row');
    const lab = el('td', null, '卸元のこの拠点は突合しない（対象外）');
    lab.colSpan = 5;
    igRow.appendChild(lab);
    kyoten.forEach(k => {
      const td = el('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = S.ignoreKyoten.includes(k);
      cb.setAttribute('aria-label', k + ' を対象外にする');
      cb.addEventListener('change', () => setKyotenIgnore(k, cb.checked));
      td.appendChild(cb); igRow.appendChild(td);
    });
    igRow.appendChild(el('td'));
    tbody.appendChild(igRow);

    groupsNow().forEach(g => {
      const cur = S.mappings.find(m => m.bumon === g.bumon && m.shiireCd === g.shiireCd);
      const row = el('tr');
      row.appendChild(el('td', null, g.bumon));
      row.appendChild(el('td', null, g.shiireCd));
      const nm = el('td', null, g.shiireNm);
      const hidden = cur && !cur.ignore ? cur.kyoten.filter(k => !presentK.has(k)) : [];
      if (hidden.length) nm.appendChild(el('div', 'mini', '今月のファイルに無い拠点：' + hidden.join('、') + '（設定は残しています）'));
      row.appendChild(nm);
      row.appendChild(el('td', 'num', g.count.toLocaleString()));
      row.appendChild(el('td', 'num', yen(g.amount)));
      kyoten.forEach(k => {
        const td = el('td');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!(cur && !cur.ignore && (cur.kyoten || []).includes(k));
        cb.addEventListener('change', () => setMap(g, k, cb.checked, false));
        td.appendChild(cb); row.appendChild(td);
      });
      const tdIg = el('td');
      const ig = document.createElement('input');
      ig.type = 'checkbox';
      ig.checked = !!(cur && cur.ignore);
      ig.addEventListener('change', () => setMap(g, null, ig.checked, true));
      tdIg.appendChild(ig); row.appendChild(tdIg);
      tbody.appendChild(row);
    });

    renderMapMsg();
  }

  function setMap(g, kyotenName, on, isIgnore) {
    let m = S.mappings.find(x => x.bumon === g.bumon && x.shiireCd === g.shiireCd);
    if (!m) { m = { bumon: g.bumon, shiireCd: g.shiireCd, kyoten: [], ignore: false }; S.mappings.push(m); }
    if (isIgnore) {
      if (on) {
        // 今月は画面に見えていない拠点との組み合わせも外れるので、確かめてから進める
        const ks = presentKyotenSet();
        const hidden = m.kyoten.filter(k => !ks.has(k));
        if (hidden.length && !confirm('この組は、今月のファイルに無い拠点（' + hidden.join('、') + '）とも組んでいます。' +
          '\n対象外にすると、その拠点との組み合わせも外れます。よろしいですか。')) { renderMap(); return; }
      }
      m.ignore = on;
      if (on) {
        // 組を対象外にしたら、その組だけが受け持っていた拠点も対象外にする（同じ拠点（部門）の中で見る）
        m.kyoten.filter(k => !S.mappings.some(x => x !== m && x.bumon === m.bumon && !x.ignore && x.kyoten.includes(k)))
          .forEach(k => { if (!S.ignoreKyoten.includes(k)) S.ignoreKyoten.push(k); });
        m.kyoten = [];
      }
    } else {
      m.ignore = false;
      const set = new Set(m.kyoten || []);
      if (on) set.add(kyotenName); else set.delete(kyotenName);
      m.kyoten = [...set];
      if (on) S.ignoreKyoten = S.ignoreKyoten.filter(k => k !== kyotenName);
    }
    S.mappings = S.mappings.filter(x => x.ignore || (x.kyoten && x.kyoten.length));
    invalidateResult(); saveCfg(); renderMap(); refresh();
  }

  function setKyotenIgnore(k, on) {
    if (on) {
      if (!S.ignoreKyoten.includes(k)) S.ignoreKyoten.push(k);
      // 対象外にした拠点は、選んでいる拠点（部門）の組から外す。突き合わせる拠点が無くなった組は対象外にする。
      // 他の拠点（部門）の設定には触れない
      S.mappings.forEach(m => {
        if (m.bumon !== S.bumon || m.ignore || !m.kyoten.includes(k)) return;
        m.kyoten = m.kyoten.filter(x => x !== k);
        if (!m.kyoten.length) m.ignore = true;
      });
    } else {
      S.ignoreKyoten = S.ignoreKyoten.filter(x => x !== k);
    }
    invalidateResult(); saveCfg(); renderMap(); refresh();
  }

  // 保存した対応表は、今月のファイルに無い組・拠点、選んでいない拠点（部門）のものも消さずに残す
  // （行の無い月をまたいでも、拠点を切り替えても、設定し直さなくてよいように）。
  // 画面の表示・実行してよいかの判定・集計には、選んだ拠点の、今月のファイルにある組・拠点だけを使う
  const gkey = (b, c) => JSON.stringify([b, c]);
  function groupsNow() { return S.suggest && S.bumon != null ? S.suggest.groups.filter(g => g.bumon === S.bumon) : []; }
  function presentGroupKeys() { return new Set(groupsNow().map(g => gkey(g.bumon, g.shiireCd))); }
  function presentKyotenSet() { return new Set(S.suggest ? S.suggest.kyoten.map(k => k.kyoten) : []); }
  function liveNow() {
    const gs = presentGroupKeys(), ks = presentKyotenSet();
    return S.mappings.filter(m => !m.ignore && gs.has(gkey(m.bumon, m.shiireCd)))
      .map(m => Object.assign({}, m, { kyoten: m.kyoten.filter(k => ks.has(k)) }));
  }
  /** 今月突合する組。今月のファイルにある拠点と1つ以上組んでいるものだけ */
  function activeMappings() { return liveNow().filter(m => m.kyoten.length); }
  /** 今月のファイルに無い拠点とだけ組んでいる組。今月は突合しない（設定は残す） */
  function idleMappings() { return liveNow().filter(m => !m.kyoten.length); }
  /** 集計に渡す対応表。残してある他の月・他の拠点の設定を結果に混ぜないよう、今月使うものだけを渡す */
  function runMappings() {
    const gs = presentGroupKeys();
    const out = activeMappings().map(m => ({ bumon: m.bumon, shiireCd: m.shiireCd, kyoten: m.kyoten, ignore: false }));
    S.mappings.filter(m => m.ignore && gs.has(gkey(m.bumon, m.shiireCd)))
      .forEach(m => out.push({ bumon: m.bumon, shiireCd: m.shiireCd, kyoten: [], ignore: true }));
    S.suggest.groups.filter(g => g.bumon !== S.bumon)
      .forEach(g => out.push({ bumon: g.bumon, shiireCd: g.shiireCd, kyoten: [], ignore: true }));
    return out;
  }

  function renderMapMsg() {
    const box = $('mapMsg'); clear(box);
    const gs = presentGroupKeys(), ks = presentKyotenSet();
    const groups = groupsNow();
    // 請求データは拠点ごとに届く。選んだ拠点の利用者がほとんど見当たらなければ、別の拠点のファイルを疑う
    if (groups.length && !groups.some(g => g.hits.some(h => h.ratioGroup >= 0.3))) {
      msg(box, 'warn', '選んだ拠点の利用者が、この請求データにほとんど見当たりません。別の拠点の請求データを選んでいないか確かめてください。');
    }
    const hiddenG = S.mappings.filter(m => m.bumon === S.bumon && !gs.has(gkey(m.bumon, m.shiireCd))).length;
    const hiddenK = new Set();
    S.mappings.filter(m => m.bumon === S.bumon && !m.ignore).forEach(m => m.kyoten.forEach(k => { if (!ks.has(k)) hiddenK.add(k); }));
    S.ignoreKyoten.forEach(k => { if (!ks.has(k)) hiddenK.add(k); });
    if (hiddenG || hiddenK.size) {
      msg(box, 'note', '今月のファイルに無い' + [hiddenG ? '組 ' + hiddenG + '組' : '', hiddenK.size ? '拠点 ' + hiddenK.size + '件' : ''].filter(Boolean).join('・') +
        'の設定は、翌月以降のためにそのまま残しています（今月の突合には影響しません）。');
    }
    const mapped = activeMappings();
    const covered = new Set();
    const dup = new Set();
    mapped.forEach(m => m.kyoten.forEach(k => {
      if (covered.has(k)) dup.add(k);
      covered.add(k);
    }));
    S.dupKyoten = [...dup];
    if (dup.size) {
      msg(box, 'warn', '同じ拠点が複数の組に割り当てられています：' + [...dup].join('、') +
        '。どの組と突き合わせるかが決まらないため、1つに絞ってください。');
    }
    const idle = idleMappings();
    if (idle.length) {
      const rowsOf = m => groups.find(g => g.bumon === m.bumon && g.shiireCd === m.shiireCd);
      msg(box, 'warn', '今月のファイルに無い拠点とだけ組んでいる組があります：' +
        idle.map(m => { const g = rowsOf(m); return m.bumon + '×' + m.shiireCd + '（' + g.count + '行 ' + yen(g.amount) + '円）'; }).join('、') +
        '。この組は今月は突合しません（設定は残しています）。卸元から請求が来ていないか、別の拠点と組むべきかを確かめてください。');
    }
    const ignored = S.suggest.kyoten.filter(k => !covered.has(k.kyoten) && S.ignoreKyoten.includes(k.kyoten));
    const missing = S.suggest.kyoten.filter(k => !covered.has(k.kyoten) && !S.ignoreKyoten.includes(k.kyoten));
    if (!mapped.length) {
      msg(box, 'warn', '突合する組が1つも指定されていません。このままでは突合できません。');
      return;
    }
    if (missing.length) {
      const amt = missing.reduce((s, k) => s + k.amount, 0);
      msg(box, 'warn', 'どの組にも割り当てられていない拠点があります：' +
        missing.map(k => k.kyoten + '（' + k.count + '行 ' + yen(k.amount) + '円）').join('、') +
        '。合計 ' + yen(amt) + '円 が突合されません。突合しない拠点なら、表の一番上の行で「対象外」にしてください。');
    } else {
      msg(box, 'ok', '卸元の全拠点が、いずれかの組に割り当てられているか、対象外になっています。');
    }
    if (ignored.length) {
      msg(box, 'note', '対象外にした卸元の拠点：' +
        ignored.map(k => k.kyoten + '（' + k.count + '行 ' + yen(k.amount) + '円）').join('、') + '。この分は突合しません。');
    }
    const unset = groups.filter(g => !S.mappings.some(m => m.bumon === g.bumon && m.shiireCd === g.shiireCd));
    if (unset.length) {
      msg(box, 'warn', '拠点も「対象外」も指定していない組が ' + unset.length + ' 組あります（' +
        unset.slice(0, 5).map(g => g.bumon + '×' + g.shiireCd).join('、') + (unset.length > 5 ? ' ほか' : '') +
        '）。このままだと範囲外として判定不能に残ります。');
    }
  }

  // ---------- 除外条件 ----------
  function renderExcl() {
    [['exclPara', S.exclPara, '卸元'], ['exclRenta', S.exclRenta, 'スマートれん太']].forEach(([id, list, label]) => {
      const box = $(id); clear(box);
      list.forEach((rule, i) => {
        const row = el('div', 'excl-row');
        row.appendChild(el('span', 'pill', label));
        const sel = document.createElement('select');
        const opts = id === 'exclPara'
          ? [['model', '型式に含む'], ['shohinNm', '商品名に含む'], ['shohinCd', '商品コードが一致']]
          : [['shohinNm', '商品名に含む'], ['shohinCd', '商品コードが一致']];
        opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; sel.appendChild(o); });
        sel.value = rule.field;
        sel.addEventListener('change', () => { rule.field = sel.value; invalidateResult(); saveCfg(); });
        row.appendChild(sel);
        const txt = document.createElement('input');
        txt.type = 'text'; txt.value = rule.value; txt.placeholder = '例: 品番の一部'; txt.style.width = '160px';
        txt.addEventListener('input', () => { rule.value = txt.value; invalidateResult(); saveCfg(); });
        row.appendChild(txt);
        const amt = document.createElement('input');
        amt.type = 'text'; amt.value = (rule.amountIn || []).join(','); amt.placeholder = '金額（空欄なら全部）';
        amt.style.width = '150px';
        amt.addEventListener('input', () => {
          rule.amountIn = amt.value.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && amt.value.trim() !== '');
          invalidateResult(); saveCfg();
        });
        row.appendChild(amt);
        const del = el('button', 'ghost', '削除');
        del.addEventListener('click', () => { list.splice(i, 1); invalidateResult(); renderExcl(); saveCfg(); });
        row.appendChild(del);
        box.appendChild(row);
      });
    });
  }

  // ---------- 実行可否 ----------
  function refresh() {
    const filesOk = !!(S.renta && S.para);
    show('cardPeriod', filesOk);
    show('cardMap', filesOk);
    show('cardOpt', filesOk);
    show('cardRun', filesOk);
    renderTaxMsg();
    if (!filesOk) { show('cardResult', false); return; }
    $('periodText').textContent = S.period;
    $('periodText2').textContent = S.period;
    if (!$('mapTable').querySelector('tbody').childNodes.length) renderMap();

    const reasons = [];
    if (loading.renta || loading.para) reasons.push('ファイルの読み込み');
    if (!$('chkPeriod').checked) reasons.push('対象年月の確認');
    if (S.bumon == null) reasons.push('拠点の選択');
    else if (!activeMappings().length) reasons.push('突合する組の指定');
    if (S.dupKyoten && S.dupKyoten.length) reasons.push('拠点の重複の解消');
    $('btnRun').disabled = reasons.length > 0;
    $('runHint').textContent = reasons.length ? reasons.join(' と ') + ' が済んでいません' : '';
  }

  /** 課税区分を1行も読めないファイルに注意を出す。列が無い・xlsx の列位置が違う場合を行の中身で拾う */
  function renderTaxMsg() {
    const box = $('taxMsg'); clear(box);
    [[S.renta, '支払予定表', '決定卸先消費税区分'], [S.para, '請求データ', '税']].forEach(([f, label, col]) => {
      if (f && f.rows.length && f.rows.every(x => !C.taxClass(x.tax))) {
        msg(box, 'note', label + 'の課税区分（「' + col + '」の列）を1行も読み取れません。列が無いか、形式が違います。' +
          '課税区分の照合はできず、突合した人は「課税区分が読めない」になります。');
      }
    });
  }

  // ---------- 実行 ----------
  function run() {
    const t0 = performance.now();
    S.renta.rows.forEach(r => { r.bucket = null; });
    S.para.rows.forEach(p => { p.bucket = null; });
    const res = M.reconcile(S.para.rows, S.renta.rows, {
      mappings: runMappings(), ignoreKyoten: S.ignoreKyoten, confirmed: S.confirmed,
      excludeParaRules: S.exclPara.filter(r => r.value),
      excludeRentaRules: S.exclRenta.filter(r => r.value)
    });
    res.ms = Math.round(performance.now() - t0);
    res.bumon = S.bumon;
    S.result = res;
    renderResult();
    saveCfg();
    show('cardResult', true);
    $('cardResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function needList() {
    const th = Number($('threshold').value) || 0;
    const showOne = $('chkOneSide').checked;
    // 課税区分の違いはしきい値に関係なく出す（税抜の差額が0でも支払額は変わるため）
    return S.result.persons
      .filter(v => v.diff !== 0 || v.taxMis.length)
      .filter(v => Math.abs(v.diff) > th || v.taxMis.length)
      .filter(v => showOne || (v.para.length && v.renta.length))
      .sort((a, b) => JA.compare(kanaOf(a), kanaOf(b)) || noOf(a) - noOf(b) || JA.compare(a.label, b.label));
  }

  // 50音順は卸元のカナを優先する（卸元の請求書と同じ並びで見比べられるように）
  const JA = new Intl.Collator('ja');
  function kanaOf(v) {
    const p = v.para.find(x => x.riyoshaKana);
    const r = v.renta.find(x => x.kana);
    return C.kanaSortKey(p ? p.riyoshaKana : (r ? r.kana : v.label));
  }
  function noOf(v) {
    const n = v.renta.length ? v.renta[0].kokyakuNo : '';
    return /^\d+$/.test(n) ? Number(n) : Number.MAX_SAFE_INTEGER;
  }

  const TAX_LABEL = { '課': '課税', '非': '非課税' };
  // 税区分の表示。読めない値は「不明」、値が無ければ空
  const taxLabel = x => {
    const t = C.taxClass(x.tax);
    return t ? TAX_LABEL[t] : (String(x.tax == null ? '' : x.tax).trim() ? '不明' : '');
  };
  /** 不一致の明細を1件ずつ返す。画面の文言も Excel の行も、ここから作る（件数と行数をそろえる） */
  function detailItems(v) {
    const out = [];
    // 金額も課税区分も違う明細は1件にまとめる
    v.pairs.filter(pr => pr.p.amount !== pr.r.amount).forEach(pr => {
      const tm = v.taxMis.includes(pr);
      out.push({ name: pr.r.shohinNm, r: pr.r, p: pr.p, taxMis: tm, kind: tm ? '金額と課税区分が違う' : '金額が違う' });
    });
    v.taxMis.filter(pr => pr.p.amount === pr.r.amount).forEach(pr =>
      out.push({ name: pr.r.shohinNm, r: pr.r, p: pr.p, taxMis: true, kind: '課税区分が違う' }));
    v.onlyPara.forEach(p => out.push({ name: p.shohinNm, r: null, p, taxMis: false, kind: 'れん太に無し' }));
    v.onlyRenta.forEach(r => out.push({ name: r.shohinNm, r, p: null, taxMis: false, kind: '卸元に請求無し' }));
    return out;
  }
  function detailText(d) {
    const taxText = '課税区分が違う（スマートれん太 ' + (d.r ? taxLabel(d.r) : '') + ' → 卸元 ' + (d.p ? taxLabel(d.p) : '') + '）';
    if (!d.r) return d.name + '：れん太に無し（卸元 ' + yen(d.p.amount) + '円）';
    if (!d.p) return d.name + '：卸元に請求無し（スマートれん太 ' + yen(d.r.amount) + '円）';
    if (d.r.amount === d.p.amount) return d.name + '：' + taxText;
    return d.name + '：' + yen(d.r.amount) + '円 → ' + yen(d.p.amount) + '円' + (d.taxMis ? '、' + taxText : '');
  }
  const detailLines = v => detailItems(v).map(detailText);

  function renderResult() {
    const res = S.result, box = $('resultMsgs');
    clear(box);
    clear($('xlsxMsg'));

    if (!res.checksum.applicable) {
      msg(box, 'warn', '金額を読み取れない行が ' + res.checksum.unknownCount +
        ' 行あるため、検算ができません。この結果は確定扱いにできません。');
    } else if (!res.checksum.ok) {
      msg(box, 'warn', '検算が合いません（左辺 ' + yen(res.checksum.lhs) + ' / 右辺 ' + yen(res.checksum.rhs) +
        '）。取りこぼしがある可能性があるので、この結果は使わないでください。');
    } else {
      msg(box, 'ok', '検算が成立しました。金額の取りこぼしはありません。');
    }

    const u = res.unresolved;
    const items = [];
    if (u.outscope) items.push('範囲外 ' + u.outscope + '行');
    if (u.unknown) items.push('金額不明 ' + u.unknown + '行');
    if (u.nameCheck) items.push('名寄せ要確認 ' + u.nameCheck + '人');
    if (u.detailCheck) items.push('明細の対応がつかない ' + u.detailCheck + '人');
    if (u.weakTier) items.push('弱い根拠で結んだ ' + u.weakTier + '人');
    if (u.noScope) items.push('拠点が特定できない ' + u.noScope + '人');
    if (u.taxUnknown) items.push('課税区分が読めない ' + u.taxUnknown + '人');
    if (items.length) {
      msg(box, 'note', '判定不能な部分が残っています：' + items.join('、') +
        '。「不一致なし」とは言えない状態です。');
    }
    const taxPeople = res.persons.filter(v => v.taxMis.length);
    if (taxPeople.length) {
      msg(box, 'note', '課税区分（課税／非課税）が食い違う明細が ' +
        taxPeople.reduce((s, v) => s + v.taxMis.length, 0) + '件（' + taxPeople.length +
        '人）あります。税抜の金額が同じでも、支払額（税込）が変わります。一覧に含めています。');
    }
    if (res.capped) msg(box, 'note', '明細の組み合わせが多すぎて、探索を打ち切った利用者があります。');

    const B = M.BUCKET;
    const k = $('kpi'); clear(k);
    const kpi = (label, value, neg) => {
      const d = el('div');
      d.appendChild(el('div', 'k', label));
      d.appendChild(el('div', 'v' + (neg ? ' neg' : ''), value));
      k.appendChild(d);
    };
    kpi('拠点', res.bumon || '（部門なし）');
    kpi('卸元の請求', yen(res.buckets[B.MATCHED].para.amount + res.buckets[B.ONESIDE].para.amount) + '円');
    kpi('スマートれん太', yen(res.buckets[B.MATCHED].renta.amount + res.buckets[B.ONESIDE].renta.amount) + '円');
    kpi('差額', (res.scopedDiff > 0 ? '+' : '') + yen(res.scopedDiff) + '円', res.scopedDiff !== 0);
    kpi('対象人数', res.persons.length.toLocaleString() + '人');
    kpi('処理時間', res.ms + 'ms');

    const list = needList();
    $('needCount').textContent = list.length + '人';

    const thead = $('resultTable').querySelector('thead');
    const tbody = $('resultTable').querySelector('tbody');
    clear(thead); clear(tbody);
    const hr = el('tr');
    COLUMNS.forEach(c => hr.appendChild(el('th', c.num ? 'num' : null, c.label)));
    thead.appendChild(hr);
    list.forEach(v => {
      const tr = el('tr');
      COLUMNS.forEach(c => {
        const val = c.get(v);
        if (c.key === 'flags') {
          const td = el('td');
          (val || []).forEach(f => td.appendChild(el('span', 'tag ' + tagKind(f), f)));
          if (v.note) td.appendChild(el('div', 'mini', v.note));
          const weak = (v.flags || []).some(f => f.indexOf('根拠:') === 0);
          if (weak && v.paraKeys.length && v.rentaKey) {
            const b = el('button', 'ghost', '同一人物として確認済みにする');
            b.style.marginTop = '4px';
            b.addEventListener('click', () => confirmPerson(v));
            td.appendChild(b);
          }
          tr.appendChild(td);
        } else if (c.key === 'detail') {
          tr.appendChild(el('td', 'detail', (val || []).join('\n')));
        } else {
          tr.appendChild(el('td', c.num ? 'num' : null, c.num && typeof val === 'number' ? yen(val) : val));
        }
      });
      tbody.appendChild(tr);
    });

    const bb = $('buckets'); clear(bb);
    const t = el('table');
    const h = el('tr');
    ['区分', '卸元 行数', '卸元 金額', 'れん太 行数', 'れん太 金額'].forEach((x, i) =>
      h.appendChild(el('th', i ? 'num' : null, x)));
    t.appendChild(h);
    Object.values(B).forEach(b => {
      const x = res.buckets[b];
      if (!x.para.count && !x.renta.count) return;
      const tr = el('tr');
      tr.appendChild(el('td', null, b));
      tr.appendChild(el('td', 'num', x.para.count.toLocaleString()));
      tr.appendChild(el('td', 'num', yen(x.para.amount)));
      tr.appendChild(el('td', 'num', x.renta.count.toLocaleString()));
      tr.appendChild(el('td', 'num', yen(x.renta.amount)));
      t.appendChild(tr);
    });
    bb.appendChild(t);
    bb.appendChild(el('p', 'mini',
      '検算：全行の差 ' + yen(res.checksum.lhs) + '円 ＝ 各区分の差の合計 ' + yen(res.checksum.rhs) + '円'));
    bb.appendChild(el('p', 'mini', taxTotalsText(res)));
  }

  function taxTotalsText(res) {
    const f = t => '課税 ' + yen(t['課']) + '円・非課税 ' + yen(t['非']) + '円' + (t['不明'] ? '・区分不明 ' + yen(t['不明']) + '円' : '');
    return '課税区分別（税抜）：卸元 ' + f(res.taxTotals.para) + '／スマートれん太 ' + f(res.taxTotals.renta);
  }

  /** 弱い根拠で結んだ人を「確認済み」に昇格させる（設計書 7.2） */
  function confirmPerson(v) {
    const paraDisp = v.paraNames.join('/'), rentaDisp = v.rentaNames.join('/');
    if (!confirm('次の2つを同一人物として登録します。\n\n卸元　　：' + paraDisp +
      '\nスマートれん太：' + rentaDisp + '\n\n次回以降は注記が出なくなります。よろしいですか。')) return;
    v.paraKeys.forEach(pk => {
      S.confirmed = S.confirmed.filter(c => c.paraKey !== pk);
      S.confirmed.push({ paraKey: pk, rentaKey: v.rentaKey, paraDisp, rentaDisp, at: new Date().toISOString() });
    });
    saveCfg();
    run();
  }

  function tagKind(f) {
    if (f.indexOf('要確認') === 0) return 'warn';
    if (f.indexOf('根拠:') === 0) return 'note';
    if (f === '合算') return 'ok';
    return '';
  }

  // 画面の表の列（1人1行）。Excel の列は下の XCOLS
  const COLUMNS = [
    { key: 'no', label: 'お客様番号', get: v => v.renta.length ? v.renta[0].kokyakuNo : '' },
    { key: 'kname', label: 'お客様名', get: v => v.renta.length ? v.renta[0].kokyakuNm : '' },
    { key: 'name', label: '利用者名', get: v => v.label },
    { key: 'tr', label: 'スマートれん太', num: true, get: v => v.tr },
    { key: 'tp', label: '卸元の請求', num: true, get: v => v.tp },
    { key: 'diff', label: '差額', num: true, get: v => v.diff },
    { key: 'cnt', label: '件数', num: true, get: v => v.pairs.filter(p => p.p.amount !== p.r.amount || v.taxMis.includes(p)).length + v.onlyPara.length + v.onlyRenta.length },
    { key: 'detail', label: '不一致の内容', get: v => detailLines(v) },
    { key: 'flags', label: '注記', get: v => v.flags },
    { key: 'names', label: '両側の表記', get: v => ((v.flags || []).some(f => f.indexOf('根拠:') === 0) || (v.flags || []).includes('合算')) ? ('卸元 ' + v.paraNames.join('/') + ' ／ れん太 ' + v.rentaNames.join('/')) : '' }
  ];

  // Excel の列（明細1件1行）。kind は書式の種類、w は列幅。per は、人ごと（最初の行にだけ出す）か、明細ごと（全部の行に出す）か。
  // sum は、上の合計を置く列
  const scol = k => COLUMNS.find(c => c.key === k);
  const XCOLS = [
    { key: 'no', label: 'お客様番号', w: 12, kind: 'text', per: 'person', get: scol('no').get },
    { key: 'kname', label: 'お客様名', w: 20, kind: 'text', per: 'person', get: scol('kname').get },
    { key: 'name', label: '利用者名', w: 18, kind: 'text', per: 'person', get: scol('name').get },
    { key: 'item', label: '商品名', w: 42, kind: 'text', per: 'detail', get: (v, d) => d.name },
    { key: 'ramt', label: 'スマートれん太', w: 15, kind: 'num', per: 'detail', sum: 'r', get: (v, d) => d.r ? d.r.amount : '' },
    { key: 'rtax', label: '税区分', w: 8, kind: 'tax', per: 'detail', get: (v, d) => d.r ? taxLabel(d.r) : '' },
    { key: 'pamt', label: '卸元の請求', w: 13, kind: 'num', per: 'detail', sum: 'p', get: (v, d) => d.p ? d.p.amount : '' },
    { key: 'ptax', label: '税区分', w: 8, kind: 'tax', per: 'detail', get: (v, d) => d.p ? taxLabel(d.p) : '' },
    { key: 'ddiff', label: '差額', w: 11, kind: 'diff', per: 'detail', sum: 'd', get: (v, d) => (d.r ? d.r.amount : 0) - (d.p ? d.p.amount : 0) },
    { key: 'kind', label: '不一致の内容', w: 20, kind: 'text', per: 'detail', get: (v, d) => d.kind },
    { key: 'flags', label: '注記', w: 26, kind: 'text', per: 'flags' },
    { key: 'names', label: '両側の表記', w: 30, kind: 'text', per: 'person', get: scol('names').get }
  ];
  const XNOTE = '表の金額は明細ごと（税抜）。差額は スマートれん太 − 卸元の請求。税区分が違う明細は、税区分を赤字にしている。';

  // ---------- Excel 出力 ----------
  const RISKY = /^[=+\-@\t\r]/;
  const safe = s => {
    const t = (s == null ? '' : String(s));
    return RISKY.test(t) ? "'" + t : t;   // 数式として解釈されないようにする（設計書 12.3）
  };

  /** 出力の中身を組み立てる（設計書 12）。上に要点だけ、表は書式つき、細かい条件は表の下 */
  function buildSheet() {
    const res = S.result, B = M.BUCKET;
    const list = needList();
    const now = new Date();
    const stamp = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' +
      String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
    const bumonName = res.bumon || '（部門なし）';
    const totalR = res.buckets[B.MATCHED].renta.amount + res.buckets[B.ONESIDE].renta.amount;
    const totalP = res.buckets[B.MATCHED].para.amount + res.buckets[B.ONESIDE].para.amount;
    const taxOnly = list.filter(v => v.diff === 0).length;
    const u = res.unresolved;
    const th = Number($('threshold').value) || 0;

    const LINE = 'D0D5DD', SUB = '5A6273';
    const ST = {
      title: { font: { bold: true, size: 14 } },
      stamp: { font: { size: 9, color: '8A91A0' }, align: { h: 'right' } },
      sumLabel: { font: { size: 9, color: SUB }, fill: 'F3F5F9', border: LINE, align: { h: 'center' } },
      sumText: { font: { bold: true, size: 12 }, border: LINE, align: { h: 'center' } },
      sumNum: { font: { bold: true, size: 12 }, border: LINE, align: { h: 'right' }, numFmt: '#,##0' },
      sumDiff: { font: { bold: true, size: 12 }, border: LINE, align: { h: 'right' }, numFmt: '+#,##0;[Red]-#,##0;0' },
      note: { font: { size: 9, color: SUB } },
      noteHead: { font: { bold: true, size: 9, color: SUB } },
      warn: { font: { bold: true, size: 10, color: 'B42318' }, fill: 'FEF3F2' },
      head: { font: { bold: true, size: 10, color: 'FFFFFF' }, fill: '4F46E5', border: '4F46E5', align: { h: 'center', wrap: true } }
    };
    const bodyStyle = (kind, zebra, taxMis) => {
      const st = { font: { size: 10 }, border: LINE, align: { v: 'top', wrap: true } };
      if (zebra) st.fill = 'F7F8FB';
      if (kind === 'tax') { st.align = { v: 'top', h: 'center' }; if (taxMis) st.font = { size: 10, bold: true, color: 'B42318' }; }
      if (kind === 'num') { st.numFmt = '#,##0'; st.align = { v: 'top', h: 'right' }; }
      if (kind === 'diff') { st.numFmt = '+#,##0;[Red]-#,##0;0'; st.align = { v: 'top', h: 'right' }; st.font = { size: 10, bold: true }; }
      if (kind === 'count') st.align = { v: 'top', h: 'center' };
      return st;
    };
    const text = (v, style) => ({ v: safe(v), style });
    const n = XCOLS.length;
    const rows = [];
    const pad = cells => { while (cells.length < n) cells.push(null); return cells; };

    // 1) 題名
    const r1 = pad([text('レンタル卸 金額不一致一覧　' + S.period + '　' + bumonName, ST.title)]);
    r1[n - 1] = text('作成 ' + stamp, ST.stamp);
    rows.push({ height: 26, cells: r1 });

    // 2) 要点（人数と合計）。人数は左の3列、合計はそれぞれの金額の列の上に置く
    const merges = ['A1:' + X.colName(n - 2) + '1'];
    const lab = pad([]), val = pad([]);
    const labRow = rows.length + 1, valRow = labRow + 1;
    const tile = (i, label, cell) => {
      lab[i] = text(label, ST.sumLabel); val[i] = cell;
      // 金額の右隣が税区分の列なら、合計はその2列をまたいで置く
      if (XCOLS[i + 1] && XCOLS[i + 1].kind === 'tax') {
        lab[i + 1] = text('', ST.sumLabel); val[i + 1] = { v: '', style: cell.style };
        merges.push(X.colName(i) + labRow + ':' + X.colName(i + 1) + labRow, X.colName(i) + valRow + ':' + X.colName(i + 1) + valRow);
      }
    };
    const sumAt = k => XCOLS.findIndex(c => c.sum === k);
    tile(0, '不一致の人数', text(list.length + '人', ST.sumText));
    tile(1, '金額の違い', text((list.length - taxOnly) + '人', ST.sumText));
    tile(2, '課税区分だけの違い', text(taxOnly + '人', ST.sumText));
    tile(sumAt('r'), 'スマートれん太 計', { v: totalR, style: ST.sumNum });
    tile(sumAt('p'), '卸元の請求 計', { v: totalP, style: ST.sumNum });
    tile(sumAt('d'), '差額 計', { v: res.scopedDiff, style: ST.sumDiff });
    rows.push({ height: 17, cells: lab });
    rows.push({ height: 24, cells: val });

    // 3) 異常があるときだけ注意を出す（何も無ければ出さない）
    const warns = [];
    if (!res.checksum.applicable) warns.push('金額を読み取れない行が ' + res.checksum.unknownCount + '行あり、検算ができません。この結果は確定扱いにできません');
    else if (!res.checksum.ok) warns.push('検算が合いません。取りこぼしがある可能性があるので、この結果は使わないでください');
    const loose = [];
    if (u.outscope) loose.push('突合していない行 ' + u.outscope + '行');
    if (u.nameCheck) loose.push('相手を決められない人 ' + u.nameCheck + '人');
    if (u.noScope) loose.push('拠点を決められない人 ' + u.noScope + '人');
    if (u.taxUnknown) loose.push('課税区分を読めない人 ' + u.taxUnknown + '人');
    if (loose.length) warns.push(loose.join('、') + ' があります。この一覧に出ていない違いが残っているかもしれません');
    warns.forEach(w => rows.push({ height: 20, cells: pad([text('注意：' + w + '。', ST.warn)]).map(c => c || { v: '', style: ST.warn }) }));
    rows.push({ height: 16, cells: pad([text('計は、この拠点で突合した全員（' + res.persons.length.toLocaleString() + '人）の税抜の合計。' + XNOTE, ST.note)]) });
    rows.push({ height: 6, cells: [] });

    // 4) 表
    const headRow = rows.length + 1;
    rows.push({ height: 22, cells: XCOLS.map(c => text(c.label, ST.head)) });
    // 明細1件を1行にする。人ごとの項目（番号・氏名など）は最初の行にだけ出し、色は人ごとに変える。
    // 注記は最初の行に全部出す。続きの行には、明細にかかわる「明細説明未確定」だけを繰り返す（長い注記を全行に並べない）
    const DETAIL_FLAG = '明細説明未確定';
    list.forEach((v, i) => {
      const items = detailItems(v);
      const flags = ((v.flags || []).join(' ') + (v.note ? ' ' + v.note : '')).trim();
      const contFlags = (v.flags || []).includes(DETAIL_FLAG) ? DETAIL_FLAG : '';
      (items.length ? items : [null]).forEach((d, k) => {
        rows.push({ cells: XCOLS.map(c => {
          const style = bodyStyle(c.kind, i % 2 === 1, !!(d && d.taxMis));
          if (c.per === 'flags') return text(k > 0 ? contFlags : flags, style);
          if (c.per === 'person' ? k > 0 : !d) return text('', style);
          const val = c.get(v, d);
          return typeof val === 'number' ? { v: val, style } : text(val, style);
        }) });
      });
    });

    // 5) 細かい条件（後から経緯を追うための記録）
    const exc = [];
    Object.values(B).forEach(b => {
      if (b === B.MATCHED || b === B.ONESIDE) return;
      const x = res.buckets[b];
      if (x.para.count || x.renta.count) {
        exc.push(b + '：卸元 ' + x.para.count + '行 ' + yen(x.para.amount) + '円／れん太 ' + x.renta.count + '行 ' + yen(x.renta.amount) + '円');
      }
    });
    const igK = S.ignoreKyoten.filter(k => S.para.rows.some(p => p.kyoten === k));
    const gsNow = presentGroupKeys();
    const igG = S.mappings.filter(m => m.ignore && gsNow.has(gkey(m.bumon, m.shiireCd))).length;
    const cond = [
      '入力ファイル：卸元 ' + S.paraName + '　／　スマートれん太 ' + S.rentaName,
      '突合しなかったもの：ほかの拠点の行、対象外にした卸元の拠点（' + (igK.length ? igK.join('、') : 'なし') + '）、対象外にした仕入先 ' + igG + '組',
      '突合しなかった行の内訳：' + (exc.length ? exc.join('　') : 'なし'),
      taxTotalsText(res),
      '確認が要る人：明細の対応がつかない ' + u.detailCheck + '人、弱い根拠で結んだ ' + u.weakTier + '人（それぞれ「注記」に表示）　検算：' + (res.checksum.ok ? '成立' : '未成立'),
      '並び順：利用者名の50音順（卸元のカナを優先）' + (th > 0 ? '　差額 ' + th + '円以下は表示していません（課税区分の違いは金額にかかわらず表示）' : '')
    ];
    rows.push({ height: 10, cells: [] });
    rows.push({ height: 16, cells: pad([text('この一覧の条件', ST.noteHead)]) });
    cond.forEach(line => rows.push({ height: 16, cells: pad([text(line, ST.note)]) }));

    return {
      sheetName: '金額不一致一覧',
      cols: XCOLS.map(c => c.w),
      rows,
      merges,
      freezeRow: headRow,
      titleRow: headRow,
      fileName: 'レンタル卸_金額不一致一覧_' + S.period.replace(/[^0-9年月]/g, '') + '_' +
        bumonName.replace(/[\\/:*?"<>|\s]/g, '') + '.xlsx'
    };
  }

  function exportXlsx() {
    const box = $('xlsxMsg');
    clear(box);
    // 失敗したら、ボタンが無反応に見えないよう理由を出す
    try {
      const spec = buildSheet();
      X.save(X.build(spec), spec.fileName);
    } catch (e) {
      msg(box, 'warn', 'Excel を作れませんでした。ファイルは保存されていません。理由：' + (e && e.message ? e.message : String(e)));
    }
  }

  // ---------- 起動 ----------
  hookDrop('dropRenta', 'fileRenta', onRenta);
  hookDrop('dropPara', 'filePara', onPara);
  $('chkPeriod').addEventListener('change', refresh);
  $('threshold').addEventListener('input', () => { saveCfg(); if (S.result) renderResult(); });
  $('chkOneSide').addEventListener('change', () => { saveCfg(); if (S.result) renderResult(); });
  $('btnRun').addEventListener('click', run);
  $('btnXlsx').addEventListener('click', exportXlsx);

  $('btnSuggest').addEventListener('click', () => {
    if (!S.suggest || S.bumon == null) return;
    // 対象外にしてある拠点は候補に入れない（毎月押しても設定が戻らないように）。
    // 候補で作り直すのは今月のファイルにある組・拠点だけ。見えていない組・拠点の設定は残す
    const ks = presentKyotenSet(), gs = presentGroupKeys();
    // 他の拠点（部門）の組と強く重なる卸元の拠点は、この拠点では対象外にする
    S.suggest.groups.filter(g => g.bumon !== S.bumon).forEach(g => g.suggestKyoten.forEach(k => {
      if (!S.ignoreKyoten.includes(k)) S.ignoreKyoten.push(k);
    }));
    const rebuilt = groupsNow().map(g => {
      const prev = S.mappings.find(m => m.bumon === g.bumon && m.shiireCd === g.shiireCd);
      const kept = prev && !prev.ignore ? prev.kyoten.filter(k => !ks.has(k)) : [];
      const ky = [...new Set(g.suggestKyoten.filter(k => !S.ignoreKyoten.includes(k)).concat(kept))];
      return ky.length
        ? { bumon: g.bumon, shiireCd: g.shiireCd, kyoten: ky, ignore: false }
        : { bumon: g.bumon, shiireCd: g.shiireCd, kyoten: [], ignore: true };
    });
    S.mappings = rebuilt.concat(S.mappings.filter(m => !gs.has(gkey(m.bumon, m.shiireCd))));
    const assigned = new Set();
    rebuilt.filter(m => !m.ignore).forEach(m => m.kyoten.forEach(k => assigned.add(k)));
    S.ignoreKyoten = S.ignoreKyoten.filter(k => !assigned.has(k));
    invalidateResult(); saveCfg(); renderMap(); refresh();
  });
  // 空にするのは選んでいる拠点（部門）の設定だけ。ほかの拠点の設定は残す
  $('btnMapClear').addEventListener('click', () => {
    if (S.bumon == null) return;
    S.mappings = S.mappings.filter(m => m.bumon !== S.bumon); S.ignoreKyoten = [];
    invalidateResult(); saveCfg(); renderMap(); refresh();
  });

  $('btnAddExclPara').addEventListener('click', () => { S.exclPara.push({ field: 'model', value: '', amountIn: [] }); renderExcl(); });
  $('btnAddExclRenta').addEventListener('click', () => { S.exclRenta.push({ field: 'shohinNm', value: '', amountIn: [] }); renderExcl(); });
  $('btnExclCheap').addEventListener('click', () => {
    // 型式は運用ごとに違うので空欄で用意する。金額の条件だけ入れておく
    S.exclPara.push({ field: 'model', value: '', amountIn: [0, 1] });
    S.exclRenta.push({ field: 'shohinNm', value: '', amountIn: [0, 1] });
    invalidateResult(); renderExcl(); saveCfg();
  });

  $('btnCfgExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(cfgObject(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'レンタル卸チェッカー設定.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('btnCfgImport').addEventListener('click', () => $('fileCfg').click());
  let cfgSeq = 0;
  $('fileCfg').addEventListener('change', async () => {
    const f = $('fileCfg').files[0];
    if (!f) return;
    const seq = ++cfgSeq;
    try {
      const text = await f.text();
      if (seq !== cfgSeq) return;   // 後から別の設定ファイルが選ばれた
      const o = JSON.parse(text);
      const bad = validCfg(o);
      if (bad) {
        alert('この設定ファイルは使えません：' + bad);
      } else {
        applyCfg(o);
        // 読み込んだ設定で、いま開いているファイルの対応表を描き直す
        S.suggest = null;
        invalidateResult();
        renderMap(); saveCfg(); refresh();
      }
    } catch (e) {
      if (seq !== cfgSeq) return;   // 後から選ばれた設定ファイルがあるなら、古い方の失敗は知らせない
      alert('設定ファイルを読み込めませんでした。');
    } finally {
      $('fileCfg').value = '';
    }
  });

  // 出し方の説明にスクリーンショットを差し込む。
  // shots/ に画像が無ければ、その枠だけ「準備中」にして手順の文章は残す。
  // 画像取得は img 要素で行う（CSP の connect-src 'none' は fetch を止めるが img-src 'self' は通る）
  (function loadShots() {
    document.querySelectorAll('#howto figure[data-shot]').forEach(fig => {
      const name = fig.getAttribute('data-shot');
      const cap = fig.querySelector('figcaption');
      // loading="lazy" を付けると DOM の外にある間は読み込みが始まらないので付けない
      const img = new Image();
      img.alt = cap ? cap.textContent : '';
      img.addEventListener('load', () => fig.insertBefore(img, cap));
      img.addEventListener('error', () => {
        fig.classList.add('missing');
        if (cap) cap.textContent = '（' + cap.textContent + 'の画像は準備中）';
      });
      img.src = 'shots/' + name + '.png';
    });
  })();

  loadCfg();
  renderExcl();
  refresh();
})();
