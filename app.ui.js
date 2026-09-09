'use strict';
/* レンタル卸 金額不一致チェッカー — 画面まわり
   描画は textContent のみ。入力ファイルは社外由来のため innerHTML を使わない。 */

(function () {
  const C = window.AppCore, M = window.AppMatch;
  const $ = id => document.getElementById(id);
  const STORE_KEY = 'oroshi-checker/v1';

  const S = {
    renta: null, para: null, rentaName: '', paraName: '',
    period: '', suggest: null, mappings: [], confirmed: [], dupKyoten: [],
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
    return {
      version: CFG_VERSION, savedAt: new Date().toISOString(),
      mappings: S.mappings, confirmed: S.confirmed,
      exclPara: S.exclPara, exclRenta: S.exclRenta,
      threshold: Number($('threshold').value) || 0,
      showOneSide: $('chkOneSide').checked
    };
  }
  function validCfg(o) {
    if (!o || typeof o !== 'object') return '設定の形式が正しくありません';
    if (o.version !== CFG_VERSION) return '設定のバージョンが違います（' + o.version + '）';
    if (!Array.isArray(o.mappings)) return '対応表がありません';
    for (const m of o.mappings) {
      if (typeof m.bumon !== 'string' || typeof m.shiireCd !== 'string') return '対応表の中身が正しくありません';
      if (!m.ignore && !Array.isArray(m.kyoten)) return '対応表の拠点が正しくありません';
    }
    for (const k of ['confirmed', 'exclPara', 'exclRenta']) {
      if (o[k] != null && !Array.isArray(o[k])) return k + ' の形式が正しくありません';
    }
    for (const c of (o.confirmed || [])) {
      if (typeof c.paraKey !== 'string' || typeof c.rentaKey !== 'string' || !c.paraKey || !c.rentaKey) {
        return '確認済み対応表の中身が正しくありません';
      }
    }
    const seen = new Set();
    for (const c of (o.confirmed || [])) {
      if (seen.has(c.paraKey)) return '確認済み対応表に同じ相手が2回出てきます';
      seen.add(c.paraKey);
    }
    for (const k of ['exclPara', 'exclRenta']) {
      for (const r of (o[k] || [])) {
        if (['model', 'shohinNm', 'shohinCd'].indexOf(r.field) < 0) return k + ' の条件の種類が不正です';
        if (typeof r.value !== 'string') return k + ' の条件の値が不正です';
        if (r.amountIn != null && (!Array.isArray(r.amountIn) || r.amountIn.some(n => typeof n !== 'number' || !isFinite(n)))) {
          return k + ' の金額条件が不正です';
        }
      }
    }
    if (o.threshold != null && (typeof o.threshold !== 'number' || !isFinite(o.threshold) || o.threshold < 0)) {
      return 'しきい値が不正です';
    }
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
    S.confirmed = o.confirmed || [];
    S.exclPara = o.exclPara || [];
    S.exclRenta = o.exclRenta || [];
    $('threshold').value = o.threshold || 0;
    $('chkOneSide').checked = o.showOneSide !== false;
    renderExcl();
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

  async function onRenta(file) {
    clear($('loadMsg'));
    try {
      const text = await readAsText(file);
      const r = C.loadRenta(text);
      const periods = [...new Set(r.rows.map(x => x.period).filter(Boolean))];
      if (periods.length !== 1) {
        msg($('loadMsg'), 'warn', '支払予定表に年月が' + periods.length + '種類入っています（' +
          periods.join('、') + '）。1か月分だけを出力し直してください。');
        S.renta = null; refresh(); return;
      }
      S.renta = r; S.rentaName = file.name; S.period = periods[0];
      resetScope();
      markDone('dropRenta', 'fnRenta', file.name, r.rows.length.toLocaleString() + '行・' + S.period);
    } catch (e) {
      S.renta = null;
      msg($('loadMsg'), 'warn', '支払予定表を読み込めませんでした。' + e.message);
      $('dropRenta').classList.remove('done'); $('fnRenta').textContent = '';
    }
    refresh();
  }

  async function onPara(file) {
    clear($('loadMsg'));
    try {
      let p;
      if (/\.xlsx?$/i.test(file.name) && !/\.csv$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheets = wb.SheetNames.map(n => ({
          name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })
        }));
        p = C.loadParaXlsxRows(sheets);
        msg($('loadMsg'), 'note', 'xlsx 形式には拠点・利用者コード・マークの列がありません。' +
          '突合する範囲の確認と名寄せの精度が落ちます。可能であれば CSV をもらってください。');
      } else {
        p = C.loadParaCsv(await readAsText(file));
      }
      S.para = p; S.paraName = file.name;
      resetScope();
      const total = p.rows.reduce((s, x) => s + (x.amount || 0), 0);
      markDone('dropPara', 'fnPara', file.name, p.rows.length.toLocaleString() + '行・合計 ' + yen(total) + '円');
      const bad = p.rows.filter(x => x.amount == null).length;
      if (bad) msg($('loadMsg'), 'warn', '金額を読み取れない行が ' + bad + ' 行あります。検算ができないため、結果は確定扱いになりません。');
    } catch (e) {
      S.para = null;
      msg($('loadMsg'), 'warn', '請求データを読み込めませんでした。' + e.message);
      $('dropPara').classList.remove('done'); $('fnPara').textContent = '';
    }
    refresh();
  }

  // ---------- 対応表 ----------
  function renderMap() {
    if (!S.renta || !S.para) return;
    if (!S.suggest) {
      S.suggest = M.suggestMappings(S.renta.rows, S.para.rows);
      // いま読んでいるファイルに無い組・拠点は、保存済み設定から落とす
      const gk = new Set(S.suggest.groups.map(g => g.bumon + '\t' + g.shiireCd));
      const kk = new Set(S.suggest.kyoten.map(k => k.kyoten));
      const before = S.mappings.length;
      S.mappings = S.mappings
        .filter(m => gk.has(m.bumon + '\t' + m.shiireCd))
        .map(m => Object.assign({}, m, { kyoten: (m.kyoten || []).filter(k => kk.has(k)) }))
        .filter(m => m.ignore || m.kyoten.length);
      S.droppedMappings = before - S.mappings.length;
    }
    const kyoten = S.suggest.kyoten.map(k => k.kyoten);
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

    S.suggest.groups.forEach(g => {
      const cur = S.mappings.find(m => m.bumon === g.bumon && m.shiireCd === g.shiireCd);
      const row = el('tr');
      row.appendChild(el('td', null, g.bumon));
      row.appendChild(el('td', null, g.shiireCd));
      row.appendChild(el('td', null, g.shiireNm));
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
      m.ignore = on;
      if (on) m.kyoten = [];
    } else {
      m.ignore = false;
      const set = new Set(m.kyoten || []);
      if (on) set.add(kyotenName); else set.delete(kyotenName);
      m.kyoten = [...set];
    }
    S.mappings = S.mappings.filter(x => x.ignore || (x.kyoten && x.kyoten.length));
    saveCfg(); renderMap(); refresh();
  }

  function renderMapMsg() {
    const box = $('mapMsg'); clear(box);
    if (S.droppedMappings) {
      msg(box, 'note', '保存されていた設定のうち ' + S.droppedMappings +
        ' 件は、今回のファイルに無い組だったので外しました。内容を確認してください。');
    }
    const mapped = S.mappings.filter(m => !m.ignore);
    const covered = new Set();
    const dup = new Set();
    mapped.forEach(m => (m.kyoten || []).forEach(k => {
      if (covered.has(k)) dup.add(k);
      covered.add(k);
    }));
    S.dupKyoten = [...dup];
    if (dup.size) {
      msg(box, 'warn', '同じ拠点が複数の組に割り当てられています：' + [...dup].join('、') +
        '。どの組と突き合わせるかが決まらないため、1つに絞ってください。');
    }
    const missing = S.suggest.kyoten.filter(k => !covered.has(k.kyoten));
    if (!mapped.length) {
      msg(box, 'warn', '突合する組が1つも指定されていません。このままでは突合できません。');
      return;
    }
    if (missing.length) {
      const amt = missing.reduce((s, k) => s + k.amount, 0);
      msg(box, 'warn', 'どの組にも割り当てられていない拠点があります：' +
        missing.map(k => k.kyoten + '（' + k.count + '行 ' + yen(k.amount) + '円）').join('、') +
        '。合計 ' + yen(amt) + '円 が突合されません。');
    } else {
      msg(box, 'ok', '卸元の全拠点が、いずれかの組に割り当てられています。');
    }
  }

  // ---------- 除外条件 ----------
  function renderExcl() {
    [['exclPara', S.exclPara, '卸元'], ['exclRenta', S.exclRenta, '基幹システム']].forEach(([id, list, label]) => {
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
        sel.addEventListener('change', () => { rule.field = sel.value; saveCfg(); });
        row.appendChild(sel);
        const txt = document.createElement('input');
        txt.type = 'text'; txt.value = rule.value; txt.placeholder = '例: 品番の一部'; txt.style.width = '160px';
        txt.addEventListener('input', () => { rule.value = txt.value; saveCfg(); });
        row.appendChild(txt);
        const amt = document.createElement('input');
        amt.type = 'text'; amt.value = (rule.amountIn || []).join(','); amt.placeholder = '金額（空欄なら全部）';
        amt.style.width = '150px';
        amt.addEventListener('input', () => {
          rule.amountIn = amt.value.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && amt.value.trim() !== '');
          saveCfg();
        });
        row.appendChild(amt);
        const del = el('button', 'ghost', '削除');
        del.addEventListener('click', () => { list.splice(i, 1); renderExcl(); saveCfg(); });
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
    if (!filesOk) { show('cardResult', false); return; }
    $('periodText').textContent = S.period;
    $('periodText2').textContent = S.period;
    if (!$('mapTable').querySelector('tbody').childNodes.length) renderMap();

    const reasons = [];
    if (!$('chkPeriod').checked) reasons.push('対象年月の確認');
    if (!S.mappings.filter(m => !m.ignore).length) reasons.push('突合する組の指定');
    if (S.dupKyoten && S.dupKyoten.length) reasons.push('拠点の重複の解消');
    $('btnRun').disabled = reasons.length > 0;
    $('runHint').textContent = reasons.length ? reasons.join(' と ') + ' が済んでいません' : '';
  }

  // ---------- 実行 ----------
  function run() {
    const t0 = performance.now();
    S.renta.rows.forEach(r => { r.bucket = null; });
    S.para.rows.forEach(p => { p.bucket = null; });
    const res = M.reconcile(S.para.rows, S.renta.rows, {
      mappings: S.mappings, confirmed: S.confirmed,
      excludeParaRules: S.exclPara.filter(r => r.value),
      excludeRentaRules: S.exclRenta.filter(r => r.value)
    });
    res.ms = Math.round(performance.now() - t0);
    S.result = res;
    renderResult();
    saveCfg();
    show('cardResult', true);
    $('cardResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function needList() {
    const th = Number($('threshold').value) || 0;
    const showOne = $('chkOneSide').checked;
    return S.result.persons
      .filter(v => v.diff !== 0)
      .filter(v => Math.abs(v.diff) > th)
      .filter(v => showOne || (v.para.length && v.renta.length))
      .sort((a, b) => {
        const na = a.renta.length ? a.renta[0].kokyakuNo : '';
        const nb = b.renta.length ? b.renta[0].kokyakuNo : '';
        const ia = /^\d+$/.test(na) ? Number(na) : Infinity;
        const ib = /^\d+$/.test(nb) ? Number(nb) : Infinity;
        return ia - ib || String(a.label).localeCompare(String(b.label), 'ja');
      });
  }

  function detailLines(v) {
    const out = [];
    v.pairs.filter(pr => pr.p.amount !== pr.r.amount).forEach(pr =>
      out.push(pr.r.shohinNm + '：' + yen(pr.r.amount) + '円 → ' + yen(pr.p.amount) + '円'));
    v.onlyPara.forEach(p =>
      out.push(p.shohinNm + '：基幹システムに無し（卸元 ' + yen(p.amount) + '円）'));
    v.onlyRenta.forEach(r =>
      out.push(r.shohinNm + '：卸元に請求無し（基幹システム ' + yen(r.amount) + '円）'));
    return out;
  }

  function renderResult() {
    const res = S.result, box = $('resultMsgs');
    clear(box);

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
    if (items.length) {
      msg(box, 'note', '判定不能な部分が残っています：' + items.join('、') +
        '。「不一致なし」とは言えない状態です。');
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
    kpi('卸元の請求', yen(res.buckets[B.MATCHED].para.amount + res.buckets[B.ONESIDE].para.amount) + '円');
    kpi('基幹システム', yen(res.buckets[B.MATCHED].renta.amount + res.buckets[B.ONESIDE].renta.amount) + '円');
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
    ['区分', '卸元 行数', '卸元 金額', '基幹 行数', '基幹 金額'].forEach((x, i) =>
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
  }

  /** 弱い根拠で結んだ人を「確認済み」に昇格させる（設計書 7.2） */
  function confirmPerson(v) {
    const paraDisp = v.paraNames.join('/'), rentaDisp = v.rentaNames.join('/');
    if (!confirm('次の2つを同一人物として登録します。\n\n卸元　　：' + paraDisp +
      '\n基幹システム：' + rentaDisp + '\n\n次回以降は注記が出なくなります。よろしいですか。')) return;
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

  const COLUMNS = [
    { key: 'no', label: 'お客様番号', get: v => v.renta.length ? v.renta[0].kokyakuNo : '' },
    { key: 'kname', label: 'お客様名', get: v => v.renta.length ? v.renta[0].kokyakuNm : '' },
    { key: 'name', label: '利用者名', get: v => v.label },
    { key: 'names', label: '両側の表記', get: v => ((v.flags || []).some(f => f.indexOf('根拠:') === 0) || (v.flags || []).includes('合算')) ? ('卸元 ' + v.paraNames.join('/') + ' ／ 基幹 ' + v.rentaNames.join('/')) : '' },
    { key: 'tr', label: '基幹システム', num: true, get: v => v.tr },
    { key: 'tp', label: '卸元の請求', num: true, get: v => v.tp },
    { key: 'diff', label: '差額', num: true, get: v => v.diff },
    { key: 'cnt', label: '件数', num: true, get: v => v.pairs.filter(p => p.p.amount !== p.r.amount).length + v.onlyPara.length + v.onlyRenta.length },
    { key: 'detail', label: '不一致の内容', get: v => detailLines(v) },
    { key: 'flags', label: '注記', get: v => v.flags }
  ];

  // ---------- Excel 出力 ----------
  const RISKY = /^[=+\-@\t\r]/;
  const safe = s => {
    const t = (s == null ? '' : String(s));
    return RISKY.test(t) ? "'" + t : t;   // 数式として解釈されないようにする（設計書 12.3）
  };

  function exportXlsx() {
    const res = S.result, B = M.BUCKET;
    const list = needList();
    const aoa = [];
    const now = new Date();
    const stamp = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' +
      String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');

    aoa.push([safe('レンタル卸 金額不一致一覧　' + S.period)]);
    aoa.push([safe('卸元 ' + S.paraName + '　／　基幹システム ' + S.rentaName + '　／　作成 ' + stamp)]);
    aoa.push([safe('卸元の請求 ' + yen(res.buckets[B.MATCHED].para.amount + res.buckets[B.ONESIDE].para.amount) +
      '円　基幹システム ' + yen(res.buckets[B.MATCHED].renta.amount + res.buckets[B.ONESIDE].renta.amount) +
      '円　差額 ' + (res.scopedDiff > 0 ? '+' : '') + yen(res.scopedDiff) + '円')]);
    const exc = [];
    Object.values(B).forEach(b => {
      if (b === B.MATCHED || b === B.ONESIDE) return;
      const x = res.buckets[b];
      if (x.para.count || x.renta.count) {
        exc.push(b + '：卸元 ' + x.para.count + '行 ' + yen(x.para.amount) + '円／基幹 ' + x.renta.count + '行 ' + yen(x.renta.amount) + '円');
      }
    });
    aoa.push([safe('対象外の内訳　' + (exc.length ? exc.join('　') : 'なし'))]);
    const u = res.unresolved;
    aoa.push([safe('判定不能：範囲外' + u.outscope + '行／金額不明' + u.unknown + '行／名寄せ要確認' + u.nameCheck +
      '人／明細未確定' + u.detailCheck + '人／弱い根拠' + u.weakTier + '人／拠点不明' + (u.noScope || 0) + '人' +
      (res.checksum.ok ? '　検算：成立' : '　検算：未成立'))]);
    const th = Number($('threshold').value) || 0;
    if (th > 0) aoa.push([safe('差額 ' + th + '円以下は表示していません')]);
    aoa.push([]);
    aoa.push(COLUMNS.map(c => c.label));
    list.forEach(v => {
      aoa.push(COLUMNS.map(c => {
        const val = c.get(v);
        if (c.key === 'detail') return safe((val || []).join('\n'));
        if (c.key === 'flags') return safe(((val || []).join(' ') + (v.note ? ' ' + v.note : '')).trim());
        if (c.num) return typeof val === 'number' ? val : safe(val);
        return safe(val);
      }));
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 34 }, { wch: 13 }, { wch: 13 }, { wch: 11 }, { wch: 7 }, { wch: 60 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '金額不一致一覧');
    const fname = 'レンタル卸_金額不一致一覧_' + S.period.replace(/[^0-9年月]/g, '') + '.xlsx';
    XLSX.writeFile(wb, fname, { compression: true });
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
    if (!S.suggest) return;
    S.mappings = S.suggest.groups.map(g => g.suggestIgnore
      ? { bumon: g.bumon, shiireCd: g.shiireCd, kyoten: [], ignore: true }
      : { bumon: g.bumon, shiireCd: g.shiireCd, kyoten: g.suggestKyoten.slice(), ignore: false });
    saveCfg(); renderMap(); refresh();
  });
  $('btnMapClear').addEventListener('click', () => { S.mappings = []; saveCfg(); renderMap(); refresh(); });

  $('btnAddExclPara').addEventListener('click', () => { S.exclPara.push({ field: 'model', value: '', amountIn: [] }); renderExcl(); });
  $('btnAddExclRenta').addEventListener('click', () => { S.exclRenta.push({ field: 'shohinNm', value: '', amountIn: [] }); renderExcl(); });
  $('btnExclCheap').addEventListener('click', () => {
    // 型式は運用ごとに違うので空欄で用意する。金額の条件だけ入れておく
    S.exclPara.push({ field: 'model', value: '', amountIn: [0, 1] });
    S.exclRenta.push({ field: 'shohinNm', value: '', amountIn: [0, 1] });
    renderExcl(); saveCfg();
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
  $('fileCfg').addEventListener('change', async () => {
    const f = $('fileCfg').files[0];
    if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      const bad = validCfg(o);
      if (bad) { alert('この設定ファイルは使えません：' + bad); return; }
      applyCfg(o); saveCfg(); renderMap(); refresh();
    } catch (e) { alert('設定ファイルを読み込めませんでした。'); }
    $('fileCfg').value = '';
  });

  loadCfg();
  renderExcl();
  refresh();
})();
