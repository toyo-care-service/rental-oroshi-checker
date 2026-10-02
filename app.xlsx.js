'use strict';
/* レンタル卸 金額不一致チェッカー — 書式つき Excel（xlsx）の書き出し
   同梱の SheetJS は書式を書けないため、1シートの xlsx を自前で組み立てる。外部ライブラリは使わない。
   文字列はすべて文字列セル（inlineStr）で書くので、Excel が式として解釈することはない。 */

(function () {
  // ---------- ZIP（無圧縮） ----------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
      head.setUint16(8, 0, true); head.setUint16(10, 0, true); head.setUint16(12, 0x21, true);
      head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true);
      head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
      parts.push(new Uint8Array(head.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    all.forEach(p => { out.set(p, pos); pos += p.length; });
    return out;
  }

  // ---------- XML ----------
  // XML 1.0 で使えない制御文字は捨てる（入力ファイル由来の文字列に紛れていても、開けないファイルを作らない）
  const BAD_XML = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
  const clean = v => String(v == null ? '' : v).replace(BAD_XML, '');
  function esc(v) {
    return clean(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Excel の上限。超えるファイルは Excel で開けない・欠けるおそれがあるので、作らずに理由を付けて止める
  const MAX_ROWS = 1048576, MAX_CELL_CHARS = 32767;
  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  }

  // ---------- 書式 ----------
  /** 書式の指定（font / fill / border / align / numFmt）を、styles.xml の番号に引き当てる */
  function StyleBook(fontName) {
    const fonts = [], fills = ['none', 'gray125'], borders = [''], fmts = [], xfs = [];
    const keyOf = o => JSON.stringify(o);
    const reg = (list, o) => { const k = keyOf(o); let i = list.indexOf(k); if (i < 0) { list.push(k); i = list.length - 1; } return i; };
    const fontXml = f => '<font>' + (f.bold ? '<b/>' : '') + '<sz val="' + (f.size || 10) + '"/><color rgb="FF' + (f.color || '1F2430') +
      '"/><name val="' + esc(fontName) + '"/><family val="3"/><charset val="128"/></font>';
    reg(fonts, {});
    const self = {
      id(st) {
        st = st || {};
        const fontId = reg(fonts, st.font || {});
        const fillId = st.fill ? reg(fills, st.fill) : 0;
        const borderId = st.border ? reg(borders, st.border) : 0;
        const numFmtId = st.numFmt ? 164 + reg(fmts, st.numFmt) : 0;
        return reg(xfs, { fontId, fillId, borderId, numFmtId, align: st.align || null });
      },
      xml() {
        const side = (n, c) => '<' + n + ' style="thin"><color rgb="FF' + c + '"/></' + n + '>';
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          (fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.map((k, i) =>
            '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + esc(JSON.parse(k)) + '"/>').join('') + '</numFmts>' : '') +
          '<fonts count="' + fonts.length + '">' + fonts.map(k => fontXml(JSON.parse(k))).join('') + '</fonts>' +
          '<fills count="' + fills.length + '">' + fills.map((k, i) => i < 2
            ? '<fill><patternFill patternType="' + k + '"/></fill>'
            : '<fill><patternFill patternType="solid"><fgColor rgb="FF' + JSON.parse(k) + '"/><bgColor indexed="64"/></patternFill></fill>').join('') + '</fills>' +
          '<borders count="' + borders.length + '">' + borders.map((k, i) => {
            if (i === 0) return '<border><left/><right/><top/><bottom/><diagonal/></border>';
            const c = JSON.parse(k);
            return '<border>' + side('left', c) + side('right', c) + side('top', c) + side('bottom', c) + '<diagonal/></border>';
          }).join('') + '</borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="' + xfs.length + '">' + xfs.map(k => {
            const x = JSON.parse(k), a = x.align;
            return '<xf numFmtId="' + x.numFmtId + '" fontId="' + x.fontId + '" fillId="' + x.fillId + '" borderId="' + x.borderId +
              '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
              '<alignment vertical="' + ((a && a.v) || 'center') + '"' + (a && a.h ? ' horizontal="' + a.h + '"' : '') +
              (a && a.wrap ? ' wrapText="1"' : '') + '/></xf>';
          }).join('') + '</cellXfs>' +
          '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
          '</styleSheet>';
      }
    };
    self.id({});   // 0番は既定の書式
    return self;
  }

  /**
   * 1シートの xlsx を組み立てる
   * @param spec { sheetName, fontName, cols:[幅], rows:[{ height?, cells:[null | { v, style }] }],
   *               merges:['A1:H1'], freezeRow, filterRef, titleRow }
   *   cells の v が number なら数値セル、それ以外は文字列セル。null のセルは書かない
   * @returns Uint8Array
   */
  function build(spec) {
    const book = StyleBook(spec.fontName || '游ゴシック');
    const nCols = spec.cols.length;
    let sheetData = '';
    if (spec.rows.length > MAX_ROWS) {
      throw new Error('行数（' + spec.rows.length.toLocaleString() + '行）が、Excel の上限（' + MAX_ROWS.toLocaleString() + '行）を超えています');
    }
    spec.rows.forEach((row, ri) => {
      const r = ri + 1;
      let cells = '';
      (row.cells || []).forEach((c, ci) => {
        if (c == null) return;
        const ref = colName(ci) + r, s = book.id(c.style);
        if (typeof c.v === 'number' && isFinite(c.v)) cells += '<c r="' + ref + '" s="' + s + '"><v>' + c.v + '</v></c>';
        else if (c.v == null || c.v === '') cells += '<c r="' + ref + '" s="' + s + '"/>';
        else {
          const len = clean(c.v).length;
          if (len > MAX_CELL_CHARS) {
            throw new Error('セル ' + ref + ' の文字数（' + len.toLocaleString() + '文字）が、Excel の上限（' + MAX_CELL_CHARS.toLocaleString() + '文字）を超えています');
          }
          cells += '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(c.v) + '</t></is></c>';
        }
      });
      sheetData += '<row r="' + r + '"' + (row.height ? ' ht="' + row.height + '" customHeight="1"' : '') + '>' + cells + '</row>';
    });
    const lastRef = colName(nCols - 1) + Math.max(1, spec.rows.length);
    const quoted = "'" + String(spec.sheetName).replace(/'/g, "''") + "'";
    const names = [];
    if (spec.filterRef) {
      names.push('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' + esc(quoted + '!' +
        spec.filterRef.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')) + '</definedName>');
    }
    if (spec.titleRow) {
      names.push('<definedName name="_xlnm.Print_Titles" localSheetId="0">' + esc(quoted + '!$' + spec.titleRow + ':$' + spec.titleRow) + '</definedName>');
    }
    const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheet = HEAD + '<worksheet xmlns="' + NS + '" xmlns:r="' + REL + '">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + lastRef + '"/>' +
      '<sheetViews><sheetView workbookViewId="0" showGridLines="0">' +
      (spec.freezeRow ? '<pane ySplit="' + spec.freezeRow + '" topLeftCell="A' + (spec.freezeRow + 1) + '" activePane="bottomLeft" state="frozen"/>' : '') +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      '<cols>' + spec.cols.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
      '<sheetData>' + sheetData + '</sheetData>' +
      (spec.filterRef ? '<autoFilter ref="' + spec.filterRef + '"/>' : '') +
      (spec.merges && spec.merges.length ? '<mergeCells count="' + spec.merges.length + '">' +
        spec.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      '</worksheet>';
    const workbook = HEAD + '<workbook xmlns="' + NS + '" xmlns:r="' + REL + '">' +
      '<sheets><sheet name="' + esc(spec.sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
      (names.length ? '<definedNames>' + names.join('') + '</definedNames>' : '') + '</workbook>';
    const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
    return zipStore([
      { name: '[Content_Types].xml', text: HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>' },
      { name: '_rels/.rels', text: HEAD + '<Relationships xmlns="' + PKG + '">' +
          '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: workbook },
      { name: 'xl/_rels/workbook.xml.rels', text: HEAD + '<Relationships xmlns="' + PKG + '">' +
          '<Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', text: book.xml() },
      { name: 'xl/worksheets/sheet1.xml', text: sheet }
    ]);
  }

  /** ブラウザに保存させる */
  function save(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const __xlsx = { build, save, crc32, colName };
  if (typeof module !== 'undefined' && module.exports) module.exports = __xlsx;
  if (typeof window !== 'undefined') window.AppXlsx = __xlsx;
})();
