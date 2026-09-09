'use strict';
/* レンタル卸 金額不一致チェッカー — 名寄せ・明細割当・バケット・検算
   設計書 DESIGN.md v3.1 の 7章〜10章に対応 */

const C = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./app.core.js') : window.AppCore;

// ==================== 名寄せ（設計書 7） ====================

const TIER = { CONFIRMED: '⓪確認済み', BOTH: '①カナと氏名', KANA: '②カナのみ', NAME: '③氏名のみ', FUZZY: '④施設名' };
const TIER_FLAG = { '②カナのみ': '根拠:カナのみ', '③氏名のみ': '根拠:氏名のみ', '④施設名': '根拠:施設名' };

function unitKeyPara(p) {
  return p.riyoshaCd ? 'C\t' + p.riyoshaCd : 'N\t' + p.kKana + '\t' + p.kName;
}
function unitKeyRenta(r) {
  return r.kokyakuNo + '\t' + r.kName;
}

function groupBy(rows, keyFn) {
  const m = new Map();
  rows.forEach(x => {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return m;
}

function setOf(rows, f) {
  const s = new Set();
  rows.forEach(x => { if (x[f]) s.add(x[f]); });
  return s;
}
function inter(a, b) { for (const x of a) if (b.has(x)) return true; return false; }

function fuzzyHit(aSet, bSet, minLen) {
  for (const a of aSet) {
    const fa = C.facilityNorm(a);
    if (fa.length < minLen) continue;
    for (const b of bSet) {
      const fb = C.facilityNorm(b);
      if (fa.includes(fb) || fb.includes(fa)) return true;
    }
  }
  return false;
}

/**
 * @param confirmed 確認済み対応表 [{paraKey, rentaKey, paraDisp, rentaDisp}]
 * @returns persons[]
 */
function linkPersons(paraRows, rentaRows, confirmed) {
  const pUnits = groupBy(paraRows, unitKeyPara);
  const rUnits = groupBy(rentaRows, unitKeyRenta);

  const meta = new Map();
  pUnits.forEach((v, k) => meta.set('p' + k, { kana: setOf(v, 'kKana'), name: setOf(v, 'kName') }));
  rUnits.forEach((v, k) => meta.set('r' + k, { kana: setOf(v, 'kKana'), name: setOf(v, 'kName') }));

  const persons = [];
  const newPerson = (label, ps, rs, tier, flags, note, keys) => {
    const p = {
      label, para: ps.slice(), renta: rs.slice(), tier: tier || '',
      flags: flags ? flags.slice() : [], note: note || '',
      paraNames: [...new Set(ps.map(x => x.riyoshaNm))],
      rentaNames: [...new Set(rs.map(x => x.name))],
      paraKeys: (keys && keys.para) || [], rentaKey: (keys && keys.renta) || ''
    };
    persons.push(p);
    return p;
  };

  const usedR = new Set();
  const assigned = new Map();
  let pending = [...pUnits.keys()];

  // 段階⓪: 確認済み対応表
  const confMap = new Map((confirmed || []).map(c => [c.paraKey, c]));
  pending = pending.filter(pk => {
    const c = confMap.get(pk);
    if (!c || !rUnits.has(c.rentaKey) || usedR.has(c.rentaKey)) return true;
    // 元表記が変わっていたら自動適用しない（設計書 7.2）
    const nowP = [...new Set(pUnits.get(pk).map(x => x.riyoshaNm))].join('/');
    const nowR = [...new Set(rUnits.get(c.rentaKey).map(x => x.name))].join('/');
    if (c.paraDisp && c.paraDisp !== nowP) return true;
    if (c.rentaDisp && c.rentaDisp !== nowR) return true;
    usedR.add(c.rentaKey);
    assigned.set(c.rentaKey, newPerson(pUnits.get(pk)[0].riyoshaNm, pUnits.get(pk),
      rUnits.get(c.rentaKey), TIER.CONFIRMED, [], '', { para: [pk], renta: c.rentaKey }));
    return false;
  });

  const tiers = [
    [TIER.BOTH, (pm, rm) => inter(pm.kana, rm.kana) && inter(pm.name, rm.name)],
    [TIER.KANA, (pm, rm) => inter(pm.kana, rm.kana)],
    [TIER.NAME, (pm, rm) => inter(pm.name, rm.name)],
    [TIER.FUZZY, (pm, rm) => fuzzyHit(pm.kana, rm.kana, 5) || fuzzyHit(pm.name, rm.name, 4)]
  ];

  for (const [tierName, test] of tiers) {
    const free = [...rUnits.keys()].filter(rk => !usedR.has(rk));
    const cand = new Map(), rev = new Map();
    pending.forEach(pk => {
      const pm = meta.get('p' + pk);
      const list = free.filter(rk => test(pm, meta.get('r' + rk)));
      cand.set(pk, list);
      list.forEach(rk => { if (!rev.has(rk)) rev.set(rk, []); rev.get(rk).push(pk); });
    });
    const done = new Set(), next = [];
    for (const pk of pending) {
      if (done.has(pk)) continue;
      const list = cand.get(pk);
      if (list.length === 1) {
        const rk = list[0];
        // rk を指す全パラケア側が、いずれも候補1つ（同じ相手）なら 1対多として確定
        const group = rev.get(rk).filter(q => cand.get(q).length === 1 && cand.get(q)[0] === rk);
        if (group.length === rev.get(rk).length) {
          usedR.add(rk);
          const allP = group.flatMap(q => pUnits.get(q));
          const names = [...new Set(group.map(q => pUnits.get(q)[0].riyoshaNm))].sort();
          const flags = [];
          if (TIER_FLAG[tierName]) flags.push(TIER_FLAG[tierName]);
          if (group.length > 1) flags.push('合算');
          const note = group.length > 1
            ? '卸元側で利用者コードが分かれています（' + names.join(' / ') + ' を同一人物として合算）' : '';
          assigned.set(rk, newPerson(names[0], allP, rUnits.get(rk), tierName, flags, note,
            { para: group.slice(), renta: rk }));
          group.forEach(q => done.add(q));
          continue;
        }
      }
      next.push(pk);
    }
    pending = next.filter(q => !done.has(q));
  }

  // 強い段階ですでに確定した相手へ寄せられるか
  // （卸元側で1人が複数の利用者コードに分かれている場合。設計書 7.3）
  const stillPending = [];
  pending.forEach(pk => {
    const pm = meta.get('p' + pk);
    let hit = null, hitTier = '';
    for (const [tierName, test] of tiers) {
      const hits = [...rUnits.keys()].filter(rk => assigned.has(rk) && test(pm, meta.get('r' + rk)));
      if (hits.length === 1) { hit = hits[0]; hitTier = tierName; break; }
      if (hits.length > 1) break;
    }
    if (!hit) { stillPending.push(pk); return; }
    const tgt = assigned.get(hit);
    tgt.para = tgt.para.concat(pUnits.get(pk));
    tgt.paraNames = [...new Set(tgt.para.map(x => x.riyoshaNm))];
    if (!tgt.flags.includes('合算')) tgt.flags.push('合算');
    if (TIER_FLAG[hitTier] && !tgt.flags.includes(TIER_FLAG[hitTier])) tgt.flags.push(TIER_FLAG[hitTier]);
    tgt.paraKeys = tgt.paraKeys.concat([pk]);
    tgt.note = '卸元側で利用者コードが分かれています（' + tgt.paraNames.join(' / ') + ' を同一人物として合算）';
  });
  pending = stillPending;

  // 残ったものは自動対応しない
  pending.forEach(pk => {
    const pm = meta.get('p' + pk);
    const others = [];
    for (const [rk, rows] of rUnits) {
      const rm = meta.get('r' + rk);
      if (inter(pm.kana, rm.kana) || inter(pm.name, rm.name)) {
        others.push(rows[0].name + '(' + rows[0].kokyakuNo + ')');
      }
    }
    const note = others.length
      ? '候補が複数あり自動対応を見送りました：' + [...new Set(others)].sort().join(' / ') : '';
    newPerson(pUnits.get(pk)[0].riyoshaNm, pUnits.get(pk), [], '',
      others.length ? ['名寄せ要確認'] : [], note);
  });

  rUnits.forEach((rows, rk) => {
    if (!usedR.has(rk)) newPerson(rows[0].name || '（お客様なし）', [], rows, '', [], '');
  });

  return persons;
}

// ==================== 明細の割当（設計書 8） ====================

const SIM_MIN = 0.45;
const MARGIN = 0.5;

function pairScore(p, r) {
  const modelHit = C.modelMatches(p.model, r.shohinNm);
  const sim = C.similarity(p.shohinNm, r.shohinNm);
  if (!modelHit && sim < SIM_MIN) return null;      // 候補にしない
  let s = 0;
  if (modelHit) s += 4;
  s += sim * 3;
  if (p.startDate && r.startDate && sameDate(p.startDate, r.startDate)) s += 1;
  if (p.amount != null && r.amount != null && p.amount === r.amount) s += 1;
  return s;
}

/** 26/02/04 と 2026/02/04 を同じ日として比較する */
function sameDate(a, b) {
  const na = normDate(a), nb = normDate(b);
  return !!na && na === nb;
}
function normDate(s) {
  const m = String(s).match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return '';
  let y = m[1];
  if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y;
  return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

const NODE_CAP = 200000;

/**
 * 最適割当を厳密に求め、次点との差で確定範囲を決める（設計書 8.2）
 * @returns {pairs:[[pi,ri]], capped:boolean, unstable:boolean}
 */
function assignDetails(paras, rentas) {
  const cand = paras.map(p => {
    const list = [];
    rentas.forEach((r, ri) => {
      const s = pairScore(p, r);
      if (s != null) list.push([ri, s]);
    });
    list.sort((a, b) => b[1] - a[1]);
    return list;
  });

  let best = null, second = null, nodes = 0, capped = false;
  const cur = [];
  const consider = (score, sol) => {
    const key = sol.map(x => x[0] + ':' + x[1]).sort().join(',');
    if (!best || score > best.score + 1e-9) { second = best; best = { score, sol: sol.slice(), key }; }
    else if (best.key !== key && (!second || score > second.score + 1e-9)) second = { score, sol: sol.slice(), key };
  };

  (function dfs(i, used, score) {
    if (nodes++ > NODE_CAP) { capped = true; return; }
    if (capped) return;
    if (i === paras.length) { consider(score, cur); return; }
    // 上界で枝刈り: 残りの最大得点を足しても best を超えないなら打ち切る
    let ub = score;
    for (let k = i; k < paras.length; k++) ub += (cand[k].length ? cand[k][0][1] : 0);
    if (best && ub < best.score - 1e-9 && second) return;
    for (const [ri, s] of cand[i]) {
      if (used.has(ri)) continue;
      used.add(ri); cur.push([i, ri]);
      dfs(i + 1, used, score + s);
      cur.pop(); used.delete(ri);
      if (capped) return;
    }
    dfs(i + 1, used, score);   // この明細を未対応にする
  })(0, new Set(), 0);

  // 探索を打ち切った場合、その途中経過を確定結果として採用しない
  if (capped) return { pairs: [], capped: true, unstable: true };
  if (!best) return { pairs: [], capped, unstable: false };
  if (!second || best.score - second.score >= MARGIN - 1e-9) {
    return { pairs: best.sol, capped, unstable: false };
  }
  // 僅差: 最適解と次点で一致する組だけを確定する
  const sec = new Set(second.sol.map(x => x[0] + ':' + x[1]));
  return { pairs: best.sol.filter(x => sec.has(x[0] + ':' + x[1])), capped, unstable: true };
}

// ==================== バケット割当と検算（設計書 10） ====================

const BUCKET = { UNKNOWN: '金額不明', OUTSCOPE: '範囲外', EXCLUDED: '除外', MATCHED: '突合済み', ONESIDE: '片側のみ' };

function matchExclude(row, rules) {
  return (rules || []).some(rule => {
    if (rule.field === 'model' && row.src === 'para') {
      if (!String(row.model || '').toUpperCase().includes(rule.value.toUpperCase())) return false;
    } else if (rule.field === 'shohinNm') {
      if (!String(row.shohinNm || '').toUpperCase().includes(rule.value.toUpperCase())) return false;
    } else if (rule.field === 'shohinCd') {
      if (String(row.shohinCd || '') !== rule.value) return false;
    } else return false;
    if (rule.amountIn && rule.amountIn.length) {
      return row.amount != null && rule.amountIn.includes(row.amount);
    }
    return true;
  });
}

/**
 * 突合を実行する
 * @param opts {mappings, confirmed, excludeParaRules, excludeRentaRules}
 */
function reconcile(paraRows, rentaRows, opts) {
  const o = opts || {};
  C.applyScope(rentaRows, paraRows, o.mappings || []);

  // 1) バケットの前段（金額不明 → 範囲外 → 除外）を先に確定させる
  const preBucket = (row, excl) => {
    if (row.amount == null) return BUCKET.UNKNOWN;
    if (!row.inScope) return BUCKET.OUTSCOPE;
    if (matchExclude(row, excl)) return BUCKET.EXCLUDED;
    return null;
  };
  paraRows.forEach(p => { p.bucket = preBucket(p, o.excludeParaRules); });
  rentaRows.forEach(r => { r.bucket = preBucket(r, o.excludeRentaRules); });

  const paraLive = paraRows.filter(p => p.bucket == null);
  const rentaLive = rentaRows.filter(r => r.bucket == null);

  // 2) 名寄せ → 明細割当。対応表の組（スコープ）をまたいで結ばないこと（設計書 6）
  const scopeIds = [...new Set(paraLive.map(x => x.scopeId).concat(rentaLive.map(x => x.scopeId)))];
  const persons = [];
  scopeIds.forEach(sid => {
    const ps = paraLive.filter(x => x.scopeId === sid);
    const rs = rentaLive.filter(x => x.scopeId === sid);
    linkPersons(ps, rs, o.confirmed).forEach(v => {
      v.scopeId = sid;
      if (sid === -1) v.flags.push('拠点が特定できない');
      persons.push(v);
    });
  });
  let capped = false;
  persons.forEach(v => {
    const res = assignDetails(v.para, v.renta);
    capped = capped || res.capped;
    v.pairs = res.pairs.map(([pi, ri]) => ({ p: v.para[pi], r: v.renta[ri] }));
    const usedP = new Set(res.pairs.map(x => x[0])), usedR = new Set(res.pairs.map(x => x[1]));
    v.onlyPara = v.para.filter((_, i) => !usedP.has(i));
    v.onlyRenta = v.renta.filter((_, i) => !usedR.has(i));
    v.pairs.forEach(pr => { pr.p.bucket = BUCKET.MATCHED; pr.r.bucket = BUCKET.MATCHED; });
    v.onlyPara.forEach(p => { p.bucket = BUCKET.ONESIDE; });
    v.onlyRenta.forEach(r => { r.bucket = BUCKET.ONESIDE; });
    if (res.capped) v.flags.push('明細の組み合わせが多く割当を確定できない');
    if (v.onlyPara.length || v.onlyRenta.length || res.unstable) v.flags.push('明細説明未確定');

    v.tp = v.para.reduce((s, x) => s + (x.amount || 0), 0);
    v.tr = v.renta.reduce((s, x) => s + (x.amount || 0), 0);
    v.diff = v.tr - v.tp;
    v.judge = v.diff === 0 ? '一致'
      : (!v.renta.length ? 'スマートれん太に無い' : (!v.para.length ? '卸元に無い' : '金額不一致'));
    // 弱い根拠で結んだうえに金額も違うものは強く出す（設計書 7.2）
    if (v.diff !== 0 && TIER_FLAG[v.tier]) v.flags.push('要確認(強)');
  });

  // 3) 検算（設計書 10.4）
  const sum = (rows, b) => rows.filter(x => x.bucket === b).reduce((s, x) => s + (x.amount || 0), 0);
  const cnt = (rows, b) => rows.filter(x => x.bucket === b).length;
  const buckets = {};
  Object.values(BUCKET).forEach(b => {
    buckets[b] = {
      para: { count: cnt(paraRows, b), amount: sum(paraRows, b) },
      renta: { count: cnt(rentaRows, b), amount: sum(rentaRows, b) }
    };
  });
  const unknown = buckets[BUCKET.UNKNOWN].para.count + buckets[BUCKET.UNKNOWN].renta.count;
  const totalPara = paraRows.reduce((s, x) => s + (x.amount || 0), 0);
  const totalRenta = rentaRows.reduce((s, x) => s + (x.amount || 0), 0);
  const rhs = [BUCKET.MATCHED, BUCKET.ONESIDE, BUCKET.EXCLUDED, BUCKET.OUTSCOPE]
    .reduce((s, b) => s + buckets[b].renta.amount - buckets[b].para.amount, 0);
  const checksum = {
    ok: unknown === 0 && (totalRenta - totalPara) === rhs,
    applicable: unknown === 0,
    lhs: totalRenta - totalPara, rhs, unknownCount: unknown
  };
  // 判定対象（突合済み＋片側のみ）の差額。利用者が見たいのはこの数字
  const scopedDiff = [BUCKET.MATCHED, BUCKET.ONESIDE]
    .reduce((s, b) => s + buckets[b].renta.amount - buckets[b].para.amount, 0);

  const unresolved = {
    outscope: paraRows.filter(x => x.bucket === BUCKET.OUTSCOPE && !x.declaredOut).length
            + rentaRows.filter(x => x.bucket === BUCKET.OUTSCOPE && !x.declaredOut).length,
    unknown,
    nameCheck: persons.filter(v => v.flags.includes('名寄せ要確認')).length,
    detailCheck: persons.filter(v => v.flags.includes('明細説明未確定')).length,
    weakTier: persons.filter(v => v.flags.some(f => f.indexOf('根拠:') === 0)).length,
    noScope: persons.filter(v => v.flags.includes('拠点が特定できない')).length
  };
  const canSayNoDiff = Object.values(unresolved).every(n => n === 0);

  return { persons, buckets, checksum, scopedDiff, unresolved, canSayNoDiff, totalPara, totalRenta, capped };
}

// ==================== 対応表の自動提案（設計書 6） ====================

/**
 * 部門×仕入先ごとに、その利用者が卸元のどの拠点と重なるかを数えて提案する。
 * 決めるのは利用者。ここは候補を出すだけ。
 */
function suggestMappings(rentaRows, paraRows) {
  const byKyoten = new Map();
  paraRows.forEach(p => {
    const k = p.kyoten || '(拠点なし)';
    if (!byKyoten.has(k)) byKyoten.set(k, { kana: new Set(), name: new Set(), ids: new Set(), count: 0, amount: 0 });
    const e = byKyoten.get(k);
    if (p.kKana) e.kana.add(p.kKana);
    if (p.kName) e.name.add(p.kName);
    e.ids.add(p.riyoshaCd || (p.kKana + '\t' + p.kName));
    e.count++; e.amount += (p.amount || 0);
  });
  byKyoten.forEach(e => { e.people = e.ids.size; });

  const byGroup = new Map();
  rentaRows.forEach(r => {
    const k = r.bumon + '\t' + r.shiireCd;
    if (!byGroup.has(k)) {
      byGroup.set(k, {
        bumon: r.bumon, shiireCd: r.shiireCd, shiireNm: r.shiireNm,
        count: 0, amount: 0, people: new Map()
      });
    }
    const e = byGroup.get(k);
    e.count++; e.amount += (r.amount || 0);
    const pid = r.kokyakuNo + '\t' + r.kName;
    if (!e.people.has(pid)) e.people.set(pid, { kana: r.kKana, name: r.kName });
  });

  const out = [];
  byGroup.forEach(g => {
    const total = g.people.size;
    const hits = [];
    byKyoten.forEach((ky, kyName) => {
      let n = 0;
      g.people.forEach(pp => {
        if ((pp.kana && ky.kana.has(pp.kana)) || (pp.name && ky.name.has(pp.name))) n++;
      });
      const kyPeople = new Set([...ky.kana, ...ky.name]).size ? ky.people : 0;
      if (n > 0) {
        hits.push({
          kyoten: kyName, matched: n,
          ratioGroup: total ? n / total : 0,
          ratioKyoten: kyPeople ? n / kyPeople : 0
        });
      }
    });
    hits.sort((a, b) => b.matched - a.matched);
    // 双方向の重なりを見る。片方向だけだと、別の仕入先でも利用者が一部重なるだけで候補に挙がってしまう
    const strong = hits.filter(h => h.ratioGroup >= 0.3 && h.ratioKyoten >= 0.5);
    out.push({
      bumon: g.bumon, shiireCd: g.shiireCd, shiireNm: g.shiireNm,
      count: g.count, amount: g.amount, people: total,
      hits, suggestKyoten: strong.map(h => h.kyoten),
      suggestIgnore: strong.length === 0
    });
  });
  out.sort((a, b) => b.amount - a.amount);

  // 1つの拠点を複数の組に提案しない。重なりが最も多い組にだけ割り当てる
  const bestOf = new Map();
  out.forEach(g => {
    g.suggestKyoten.forEach(k => {
      const h = g.hits.find(x => x.kyoten === k);
      const cur = bestOf.get(k);
      if (!cur || h.matched > cur.matched) bestOf.set(k, { group: g, matched: h.matched });
    });
  });
  out.forEach(g => {
    g.suggestKyoten = g.suggestKyoten.filter(k => bestOf.get(k) && bestOf.get(k).group === g);
    g.suggestIgnore = g.suggestKyoten.length === 0;
  });

  return { groups: out, kyoten: [...byKyoten.entries()].map(([k, v]) => ({ kyoten: k, count: v.count, amount: v.amount })) };
}

const __match = {
  linkPersons, assignDetails, reconcile, pairScore, suggestMappings,
  similarity: C.similarity, BUCKET, TIER, TIER_FLAG, normDate
};
if (typeof module !== 'undefined' && module.exports) module.exports = __match;
if (typeof window !== 'undefined') window.AppMatch = __match;
