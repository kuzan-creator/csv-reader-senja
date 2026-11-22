// transcode.js — v6: one-pass byte-level JSON-to-JSON CSV transcoder, pure JS.
// Parses CSV directly from the JSON-escaped bytes of cases.json (no JSON.parse, no decode
// buffer, no descriptor array). Field bytes are copied verbatim from input to output
// (input JSON escaping == output JSON escaping) except for the rare transforms
// ("" -> ", CR -> LF inside quotes, stray CR dropped).
// Semantik: csv-reader 1.0.0 (vendor). Output per case:
//   {"columns":...,"rows":[...],"errors":[...]}

export class NeedFallback extends Error {
  constructor() { super('NeedFallback'); }
}

const BS = 0x5C; // backslash
const QT = 0x22; // "
const CM = 0x2C; // ,
const CN = 0x6E; // n
const CR = 0x72; // r
const CU = 0x75; // u

const L_COLS = Buffer.from('{"columns":', 'latin1');
const L_ROWS = Buffer.from(',"rows":[', 'latin1');
const L_ERRS = Buffer.from('],"errors":[', 'latin1');
const L_END = Buffer.from(']}', 'latin1');
const L_NULL = Buffer.from('null', 'latin1');

// scratch (dipakai ulang antar case; BUKAN di hot path per-field)
const errBuf = Buffer.allocUnsafe(1048576);
const rowBuf = Buffer.allocUnsafe(65536);
const fieldEnds = new Int32Array(64);
let warmed = false;

// --- tulis bilangan desimal non-negatif ke buffer, return offset baru ---
function putInt(buf, o, n) {
  if (n === 0) { buf[o++] = 0x30; return o; }
  let d = 1;
  while (d * 10 <= n) d *= 10;
  while (d >= 1) {
    buf[o++] = 0x30 + (((n / d) | 0) % 10);
    d = (d / 10) | 0;
  }
  return o;
}

// --- emit {"code":"..","line":L,"row":R} ke errBuf; return eo baru ---
// (dipisah ',' otomatis bila bukan error pertama)
function errSimple(eo, code, line, row) {
  if (eo > 0) errBuf[eo++] = CM;
  errBuf[eo++] = 0x7B; // {
  eo += errBuf.write('"code":"', eo, 'latin1');
  eo += errBuf.write(code, eo, 'latin1');
  eo += errBuf.write('","line":', eo, 'latin1');
  eo = putInt(errBuf, eo, line);
  eo += errBuf.write(',"row":', eo, 'latin1');
  if (row === null) eo += errBuf.write('null', eo, 'latin1');
  else eo = putInt(errBuf, eo, row);
  errBuf[eo++] = 0x7D; // }
  return eo;
}

// --- emit {"code":"short_row","line":L,"row":R,"fields":N} ---
function errShort(eo, line, row, fields) {
  if (eo > 0) errBuf[eo++] = CM;
  errBuf[eo++] = 0x7B;
  eo += errBuf.write('"code":"short_row","line":', eo, 'latin1');
  eo = putInt(errBuf, eo, line);
  eo += errBuf.write(',"row":', eo, 'latin1');
  if (row === null) eo += errBuf.write('null', eo, 'latin1');
  else eo = putInt(errBuf, eo, row);
  eo += errBuf.write(',"fields":', eo, 'latin1');
  eo = putInt(errBuf, eo, fields);
  errBuf[eo++] = 0x7D;
  return eo;
}

// --- emit {"code":"long_row","line":L,"row":R,"extra":[...]} ---
// extra = field yang dipotong, dari rowBuf[extraLo..extraHi)
function errLong(eo, line, row, extraLo, extraHi) {
  if (eo > 0) errBuf[eo++] = CM;
  errBuf[eo++] = 0x7B;
  eo += errBuf.write('"code":"long_row","line":', eo, 'latin1');
  eo = putInt(errBuf, eo, line);
  eo += errBuf.write(',"row":', eo, 'latin1');
  if (row === null) eo += errBuf.write('null', eo, 'latin1');
  else eo = putInt(errBuf, eo, row);
  eo += errBuf.write(',"extra":[', eo, 'latin1');
  errBuf.set(rowBuf.subarray(extraLo, extraHi), eo);
  eo += extraHi - extraLo;
  errBuf[eo++] = 0x5D; // ]
  errBuf[eo++] = 0x7D; // }
  return eo;
}

// --- SWAR (byte-position): cari byte CM (,) atau BS (\) berikutnya di raw[p..end). ---
// Melacak posisi byte (p += 4), BUKAN word-index — menghindari `w << 2` yang
// tidak punya type feedback dan memicu deopt loop "Insufficient type feedback
// for binary operation" (v6 awal hang >25 detik di case 1 karenanya).
function findDelim(raw, u32, p, end) {
  while (p < end) {
    const b = raw[p];
    if (b === CM || b === BS) return p;
    if ((p & 3) === 0) break;
    p++;
  }
  const pEnd = (end >> 2) << 2;
  while (p < pEnd) {
    const word = u32[p >> 2];
    let x = (word ^ 0x2C2C2C2C) | 0;
    let h = (((x - 0x01010101) | 0) & ~x & 0x80808080) | 0;
    x = (word ^ 0x5C5C5C5C) | 0;
    h |= (((x - 0x01010101) | 0) & ~x & 0x80808080) | 0;
    if (h !== 0) {
      for (let i = 0; i < 4; i++) {
        const b = raw[p + i];
        if (b === CM || b === BS) return p + i;
      }
    }
    p += 4;
  }
  while (p < end) {
    const b = raw[p];
    if (b === CM || b === BS) return p;
    p++;
  }
  return end;
}

// --- SWAR (byte-position): cari byte 0x5C (\) berikutnya di raw[p..end). ---
function findBS(raw, u32, p, end) {
  while (p < end) {
    if (raw[p] === BS) return p;
    if ((p & 3) === 0) break;
    p++;
  }
  const pEnd = (end >> 2) << 2;
  while (p < pEnd) {
    const word = u32[p >> 2];
    const x = (word ^ 0x5C5C5C5C) | 0;
    const h = (((x - 0x01010101) | 0) & ~x & 0x80808080) | 0;
    if (h !== 0) {
      for (let i = 0; i < 4; i++) {
        if (raw[p + i] === BS) return p + i;
      }
    }
    p += 4;
  }
  while (p < end) {
    if (raw[p] === BS) return p;
    p++;
  }
  return end;
}

// --- salin verbatim raw[fs..fe) ke rowBuf di ro. Return ro baru. ---
function copyRaw(raw, fs, fe, ro) {
  for (let i = fs; i < fe; i++) rowBuf[ro++] = raw[i];
  return ro;
}

// --- salin field unquoted raw[fs..fe) dengan menangani escape JSON inline.
// Return [roBaru, dirty] — dirty=true bila ada stray CR (error sudah di-emit
// oleh pemanggil? tidak: pemanggil yang meng-emit stray_cr; di sini dirty
// hanya penanda ada transformasi). Escape ditangani per unit (\\ dulu) supaya
// \\r tidak dikira stray CR dan \\" tidak dikira doubled quote.
function copyUnquotedSlow(raw, fs, fe, ro) {
  let i = fs;
  let dirty = false;
  while (i < fe) {
    const b = raw[i];
    if (b !== BS) { rowBuf[ro++] = b; i++; continue; }
    const c = raw[i + 1];
    // Output adalah JSON: " \ LF harus dalam bentuk escape (\" \\ \n).
    if (c === CN) { rowBuf[ro++] = BS; rowBuf[ro++] = CN; i += 2; continue; } // \n -> \n
    if (c === CR) { dirty = true; i += 2; continue; } // \r -> drop (stray CR)
    if (c === BS) { rowBuf[ro++] = BS; rowBuf[ro++] = BS; i += 2; continue; } // \\ -> \\
    if (c === QT) { rowBuf[ro++] = BS; rowBuf[ro++] = QT; i += 2; continue; } // \" -> \"
    if (c === CU) throw new NeedFallback();
    rowBuf[ro++] = BS; rowBuf[ro++] = c; i += 2;
  }
  return [ro, dirty];
}

// --- salin nilai field ber-quote raw[vs..ve) ke rowBuf di ro.
// Menangani "" -> " dan \r / \r\n di dalam quote -> \n (byte 0x0A).
// (Di sini \n sudah jadi LF lewat jalur lain; yang ditangani: "" dan CR.)
function copyQuotedSlow(raw, vs, ve, ro) {
  let i = vs;
  while (i < ve) {
    const b = raw[i];
    if (b !== BS) { rowBuf[ro++] = b; i++; continue; }
    const c = raw[i + 1];
    // Output adalah JSON: " \ LF harus dalam bentuk escape.
    if (c === QT) {
      // \"\" (doubled) -> \" (satu " , JSON-escaped)
      rowBuf[ro++] = BS; rowBuf[ro++] = QT;
      if (raw[i + 2] === BS && raw[i + 3] === QT) i += 4;
      else i += 2;
      continue;
    }
    if (c === CR) {
      // \r atau \r\n di dalam quote -> \n (JSON escape untuk LF)
      rowBuf[ro++] = BS; rowBuf[ro++] = CN;
      if (raw[i + 2] === BS && raw[i + 3] === CN) i += 4;
      else i += 2;
      continue;
    }
    if (c === CN) { rowBuf[ro++] = BS; rowBuf[ro++] = CN; i += 2; continue; } // \n -> \n
    if (c === BS) { rowBuf[ro++] = BS; rowBuf[ro++] = BS; i += 2; continue; } // \\ -> \\
    if (c === CU) throw new NeedFallback();
    rowBuf[ro++] = BS; rowBuf[ro++] = c; i += 2;
  }
  return ro;
}

// E_*: akhir field
const E_COMMA = 0;
const E_BREAK = 1;
const E_END = 2;

// --- transcode satu case. raw = cases.json utuh; [ts,te) = teks JSON-escaped.
// header = boolean. out = buffer output; o = offset tulis. Return o baru.
// Output: {"columns":...,"rows":[...],"errors":[...]}
export function transcodeCase(raw, u32, ts, te, header, out, o) {
  // warm-up jalur dingin sekali per proses (supaya call-site punya feedback)
  if (!warmed) {
    warmed = true;
    try {
      errSimple(0, 'x', 1, 0);
      errShort(0, 1, 0, 0);
      errLong(0, 1, 0, 0, 0);
      copyQuotedSlow(raw, ts, ts, 0);
      copyUnquotedSlow(raw, ts, ts, 0);
    } catch (e) { /* abaikan */ }
  }

  let p = ts;
  // BOM: UTF-8 (EF BB BF) atau escape \uFEFF
  if (raw[p] === 0xEF && raw[p + 1] === 0xBB && raw[p + 2] === 0xBF) p += 3;
  else if (raw[p] === BS && raw[p + 1] === CU && raw[p + 2] === 0x46 && raw[p + 3] === 0x45 && raw[p + 4] === 0x46 && raw[p + 5] === 0x46) p += 6;

  let line = 1;
  let width = -1;
  let rowCount = 0;
  let eo = 0;
  let rowsStarted = false;

  out.set(L_COLS, o); o += L_COLS.length;

  // ================= record loop =================
  while (true) {
    // lewati baris kosong (LF / CRLF) di antara record
    while (p < te) {
      if (raw[p] === BS && raw[p + 1] === CN) { line++; p += 2; continue; }
      if (raw[p] === BS && raw[p + 1] === CR) {
        if (raw[p + 2] === BS && raw[p + 3] === CN) { line++; p += 4; continue; }
        break;
      }
      break;
    }
    if (p >= te) break;

    const recordLine = line;
    const recordRow = (width < 0 && header) ? null : rowCount;
    let fieldCount = 0;
    let ro = 0;
    let lastFieldEmpty = false;
    let lastQuoted = false;

    // ================= field loop =================
    let ended = E_END;
    while (true) {
      const fieldStart = p;
      const isQuoted = raw[p] === BS && raw[p + 1] === QT;
      let fEnd = -1; // akhir field di rowBuf (setelah '"')
      let fe = -1;   // akhir field di raw (posisi delimiter)
      let e2 = E_END;

      if (isQuoted) {
        const openLine = line;
        const vs = p + 2;
        let q = vs;
        let hasDouble = false;
        let hasCR = false;
        let ve = -1;
        let closed = false;
        while (true) {
          q = findBS(raw, u32, q, te);
          if (q >= te) break;
          const c = raw[q + 1];
          if (c === QT) {
            if (raw[q + 2] === BS && raw[q + 3] === QT) { hasDouble = true; q = q + 4; continue; }
            ve = q; closed = true; p = q + 2; break;
          }
          if (c === CN) { line++; q = q + 2; continue; }
          if (c === CR) {
            hasCR = true; line++;
            if (raw[q + 2] === BS && raw[q + 3] === CN) q = q + 4;
            else q = q + 2;
            continue;
          }
          if (c === CU) throw new NeedFallback();
          q = q + 2;
        }
        if (!closed) {
          // ---------- unterminated_quote (jalur lambat) ----------
          eo = errSimple(eo, 'unterminated_quote', recordLine, recordRow);
          line = openLine;
          rowBuf[ro++] = QT; // opening " field
          rowBuf[ro++] = BS; rowBuf[ro++] = QT; // '"' literal (escaped)
          let dirty = false;
          let fe2 = te;
          let e3 = E_END;
          let q2 = fieldStart + 2;
          while (true) {
            q2 = findDelim(raw, u32, q2, te);
            if (q2 >= te) { fe2 = te; e3 = E_END; p = te; break; }
            if (raw[q2] === CM) { fe2 = q2; e3 = E_COMMA; p = q2 + 1; break; }
            const c2 = raw[q2 + 1];
            if (c2 === CN) { fe2 = q2; e3 = E_BREAK; line++; p = q2 + 2; break; }
            if (c2 === CR) {
              if (raw[q2 + 2] === BS && raw[q2 + 3] === CN) { fe2 = q2; e3 = E_BREAK; line++; p = q2 + 4; break; }
              eo = errSimple(eo, 'stray_cr', recordLine, recordRow);
              dirty = true;
              q2 = q2 + 2;
              continue;
            }
            if (c2 === CU) throw new NeedFallback();
            q2 = q2 + 2;
          }
          // salin sisa field sebagai unquoted (dari setelah quote pembuka)
          const r0 = ro;
          let hasEsc = false;
          for (let i = fieldStart + 2; i < fe2; i++) if (raw[i] === BS) { hasEsc = true; break; }
          if (!hasEsc) ro = copyRaw(raw, fieldStart + 2, fe2, ro);
          else {
            const res = copyUnquotedSlow(raw, fieldStart + 2, fe2, ro);
            ro = res[0];
            if (res[1]) dirty = true;
          }
          void dirty;
          // field = '"' + sisa (sudah di rowBuf)
          rowBuf[ro++] = QT;
          fEnd = ro;
          fe = fe2; e2 = e3;
          lastFieldEmpty = false; lastQuoted = true;
        } else {
          // ---------- quoted tertutup ----------
          // salin nilai (closing quote DITULIS SETELAH junk — junk bagian dari nilai)
          rowBuf[ro++] = QT;
          if (!hasDouble && !hasCR) ro = copyRaw(raw, vs, ve, ro);
          else ro = copyQuotedSlow(raw, vs, ve, ro);
          // quote_junk: karakter sampai koma / line break ditempel apa adanya
          const junkFieldStart = p;
          let junkHasCR = false;
          while (true) {
            const j = findDelim(raw, u32, p, te);
            if (j >= te) { p = te; e2 = E_END; fe = te; break; }
            if (raw[j] === CM) { fe = j; e2 = E_COMMA; p = j + 1; break; }
            // raw[j] === BS: escape
            const c = raw[j + 1];
            if (c === CN) { fe = j; e2 = E_BREAK; line++; p = j + 2; break; }
            if (c === CR) {
              if (raw[j + 2] === BS && raw[j + 3] === CN) { fe = j; e2 = E_BREAK; line++; p = j + 4; break; }
              // stray CR di junk: buang + error (sebelum quote_junk)
              eo = errSimple(eo, 'stray_cr', recordLine, recordRow);
              junkHasCR = true;
              // salin junk sebelum CR, lalu lanjut setelah CR
              const jr0 = ro;
              void jr0;
              p = j + 2;
              continue;
            }
            if (c === CU) throw new NeedFallback();
            p = j + 2;
          }
          // salin junk (bila ada) — dari posisi setelah closing quote sampai fe,
          // dengan escape ditangani (\" -> ", \\ -> \, \r dibuang)
          const junkStart = junkFieldStart;
          const junkEnd = fe;
          const roBeforeJunk = ro;
          if (junkEnd > junkStart) {
            // ada junk: proses byte-per-byte (jalur lambat, jarang)
            let ji = junkStart;
            let hasEsc = false;
            for (let i = ji; i < junkEnd; i++) if (raw[i] === BS) { hasEsc = true; break; }
            if (!hasEsc) {
              for (let i = ji; i < junkEnd; i++) rowBuf[ro++] = raw[i];
            } else {
              while (ji < junkEnd) {
                const b = raw[ji];
                if (b !== BS) { rowBuf[ro++] = b; ji++; continue; }
                const c = raw[ji + 1];
                if (c === CN) { rowBuf[ro++] = BS; rowBuf[ro++] = CN; ji += 2; continue; }
                if (c === CR) { ji += 2; continue; } // stray CR dibuang
                if (c === BS) { rowBuf[ro++] = BS; rowBuf[ro++] = BS; ji += 2; continue; }
                if (c === QT) { rowBuf[ro++] = BS; rowBuf[ro++] = QT; ji += 2; continue; }
                if (c === CU) throw new NeedFallback();
                rowBuf[ro++] = BS; rowBuf[ro++] = c; ji += 2;
              }
            }
            if (ro > roBeforeJunk) eo = errSimple(eo, 'quote_junk', recordLine, recordRow);
          }
          void junkHasCR;
          rowBuf[ro++] = QT; // closing quote (setelah junk)
          fEnd = ro;
          lastFieldEmpty = false; lastQuoted = true;
        }
      } else {
        // ---------- unquoted ----------
        let q = fieldStart;
        let dirty = false;
        let fe2 = te;
        let e3 = E_END;
        while (true) {
          q = findDelim(raw, u32, q, te);
          if (q >= te) { fe2 = te; e3 = E_END; p = te; break; }
          if (raw[q] === CM) { fe2 = q; e3 = E_COMMA; p = q + 1; break; }
          const c = raw[q + 1];
          if (c === CN) { fe2 = q; e3 = E_BREAK; line++; p = q + 2; break; }
          if (c === CR) {
            if (raw[q + 2] === BS && raw[q + 3] === CN) { fe2 = q; e3 = E_BREAK; line++; p = q + 4; break; }
            eo = errSimple(eo, 'stray_cr', recordLine, recordRow);
            dirty = true;
            q = q + 2;
            continue;
          }
          if (c === CU) throw new NeedFallback();
          q = q + 2;
        }
        // salin field
        rowBuf[ro++] = QT;
        let hasEsc = false;
        for (let i = fieldStart; i < fe2; i++) if (raw[i] === BS) { hasEsc = true; break; }
        if (!hasEsc) ro = copyRaw(raw, fieldStart, fe2, ro);
        else {
          const res = copyUnquotedSlow(raw, fieldStart, fe2, ro);
          ro = res[0];
          if (res[1]) dirty = true;
        }
        void dirty;
        rowBuf[ro++] = QT;
        fEnd = ro;
        fe = fe2; e2 = e3;
        lastFieldEmpty = (fe2 === fieldStart);
        lastQuoted = false;
      }

      // simpan field
      if (fieldCount > 0) { /* pemisah antar field sudah implisit: tiap field ditulis berurutan; koma disisipkan di bawah */ }
      fieldEnds[fieldCount] = fEnd;
      fieldCount++;
      ended = e2;
      if (ended !== E_COMMA) break;
      // field berikutnya: sisipkan koma di rowBuf sebelum field berikut ditulis
      // (ditandai lewat fieldEnds: kita tulis koma sekarang)
      rowBuf[ro++] = CM;
    }

    // ---- record selesai ----
    // buang record = satu field unquoted kosong (tapi stray_cr tetap)
    if (fieldCount === 1 && lastFieldEmpty && !lastQuoted) continue;

    if (width < 0) {
      width = fieldCount;
      if (header && !rowsStarted) {
        // kolom = record pertama; emit kolom: [field...]
        out[o++] = 0x5B;
        out.set(rowBuf.subarray(0, fieldEnds[fieldCount - 1]), o);
        o += fieldEnds[fieldCount - 1];
        out[o++] = 0x5D;
        out.set(L_ROWS, o); o += L_ROWS.length;
        rowsStarted = true;
        continue;
      }
      // bukan header: kolom = null, lalu record ini jadi baris pertama
      out.set(L_NULL, o); o += L_NULL.length;
      out.set(L_ROWS, o); o += L_ROWS.length;
      rowsStarted = true;
    }
    // emit baris
    if (rowCount > 0) out[o++] = CM;
    out[o++] = 0x5B;
    if (fieldCount === width) {
      out.set(rowBuf.subarray(0, fieldEnds[fieldCount - 1]), o);
      o += fieldEnds[fieldCount - 1];
    } else if (fieldCount < width) {
      // short_row: pad ""
      eo = errShort(eo, recordLine, recordRow, fieldCount);
      out.set(rowBuf.subarray(0, fieldEnds[fieldCount - 1]), o);
      o += fieldEnds[fieldCount - 1];
      for (let k = fieldCount; k < width; k++) {
        out[o++] = CM;
        out[o++] = QT; out[o++] = QT;
      }
    } else {
      // long_row: potong ke width; extra = field selebihnya
      const extraLo = fieldEnds[width - 1] + 1; // setelah koma sesudah field ke-width
      const extraHi = fieldEnds[fieldCount - 1];
      eo = errLong(eo, recordLine, recordRow, extraLo, extraHi);
      out.set(rowBuf.subarray(0, fieldEnds[width - 1]), o);
      o += fieldEnds[width - 1];
    }
    out[o++] = 0x5D;
    rowCount++;
  }

  // tidak ada record non-discarded sama sekali
  if (width < 0) {
    width = 0;
    if (header) {
      out[o++] = 0x5B; out[o++] = 0x5D; // []
    } else {
      out.set(L_NULL, o); o += L_NULL.length;
    }
    out.set(L_ROWS, o); o += L_ROWS.length;
    rowsStarted = true;
  }
  out.set(L_ERRS, o); o += L_ERRS.length;
  if (eo > 0) {
    out.set(errBuf.subarray(0, eo), o); o += eo;
  }
  out.set(L_END, o); o += L_END.length;
  return o;
}
