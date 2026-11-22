// transcode4.js — v4 single-pass streaming transcoder (asm.js-style).
//
// Direct emission: fields are written to the output Buffer as they are
// parsed. No descriptor array, no second emit pass, no closures in the
// hot path. All hot-loop state lives in locals; helpers are top-level
// functions taking explicit arguments so V8 can keep the code optimized
// (zero-deopt asm.js style).
//
// Field bytes in the input JSON are already JSON-escaped, and csv-reader's
// own escaping of a field value is the same escaping, so a field that needs
// no CSV-level change is copied byte-for-byte from the input Buffer to the
// output Buffer. Only fields that change bytes (doubled quotes, CR to LF
// inside quotes, stray CRs, quote junk, unterminated quotes) take the slow
// byte-level decode.
//
// Escapes: the generator only ever emits \"  \n  \r (measured on practice:
// 300724 / 77715 / 40285, zero \\ and zero \u). Any other escape throws
// NeedFallback and the caller answers that case with JSON.parse + solve.js.

export class NeedFallback extends Error {}

const BS = 0x5c;
const CM = 0x2c;
const DQ = 0x22;
const NL = 0x6e;
const CRB = 0x72;

// SWAR: 32-bit mask, 0x80 in the high bit of every byte that is a
// backslash (0x5C) or a comma (0x2C).
function delimMask(w) {
  const a = w ^ 0x5c5c5c5c;
  const b = w ^ 0x2c2c2c2c;
  return ((a - 0x01010101) & ~a & 0x80808080) | ((b - 0x01010101) & ~b & 0x80808080);
}

export function makeScanner(raw) {
  const base = raw.byteOffset;
  const align = (4 - (base % 4)) % 4;
  const u32 = new Uint32Array(raw.buffer, base + align, (raw.length - align) >>> 2);
  return { u32, alignBase: align };
}

// Find the next backslash or comma at/after pos, before end.
// NOTE: SWAR zero-byte test has a borrow false positive (a ',' followed
// by '-' flags the second byte too), so every candidate is verified
// against the raw byte and a false positive is skipped.
function findDelim(raw, u32, alignBase, pos, end) {
  while (pos < end) {
    const d = findDelimRaw(u32, alignBase, pos, end);
    if (d >= end) return end;
    const b = raw[d];
    if (b === BS || b === CM) return d;
    pos = d + 1;
  }
  return end;
}

function findDelimRaw(u32, alignBase, pos, end) {
  if (pos >= end) return end;
  const startWi = (pos - alignBase) >> 2;
  const endWi = (end - 1 - alignBase) >> 2;
  const headOff = pos - (alignBase + (startWi << 2));
  const firstMask = headOff === 0 ? 0xffffffff : (0x80808080 << (headOff << 3));
  for (let wi = startWi; wi <= endWi; wi++) {
    let m = delimMask(u32[wi]);
    if (wi === startWi) m &= firstMask;
    if (wi === endWi) {
      const keep = end - (alignBase + (wi << 2));
      if (keep < 4) m &= 0x80808080 >>> ((4 - keep) << 3);
    }
    if (m !== 0) {
      const lsb = m & -m;
      const byteIdx = (31 - Math.clz32(lsb)) >>> 3;
      return alignBase + (wi << 2) + byteIdx;
    }
  }
  return end;
}

// Copy raw[s..e) to out at o, byte by byte. Fastest for the short fields
// this workload is made of (measured: beats Buffer.copy and out.set).
function copyRange(raw, s, e, out, o) {
  for (let i = s; i < e; i++) out[o++] = raw[i];
  return o;
}

// Decode one slow field's raw bytes [rs, re) into its JSON string.
// `quoted` says the field opened with a quote (rs is the opening \").
// Mirrors the reference parser's readQuoted / readUnquoted on raw bytes.
function slowFieldJSON(raw, rs, re, quoted) {
  let value = '';
  if (!quoted) {
    let i = rs;
    while (i < re) {
      if (raw[i] === BS) {
        const nb = raw[i + 1];
        if (nb === DQ) { value += '"'; i += 2; }
        else if (nb === NL) { value += '\n'; i += 2; }
        else if (nb === CRB) { i += 2; }
        else if (nb === BS) { value += '\\'; i += 2; }
        else if (nb === 0x75) {
          value += String.fromCharCode(parseInt(raw.toString('utf8', i + 2, i + 6), 16));
          i += 6;
        } else if (nb === 0x74) { value += '\t'; i += 2; }
        else if (nb === 0x62) { value += '\b'; i += 2; }
        else if (nb === 0x66) { value += '\f'; i += 2; }
        else if (nb === 0x2f) { value += '/'; i += 2; }
        else throw new NeedFallback();
      } else {
        let j = i;
        while (j < re && raw[j] !== BS) j++;
        value += raw.toString('utf8', i, j);
        i = j;
      }
    }
    return JSON.stringify(value);
  }
  let i = rs + 2;
  let closed = -1;
  let segStart = i;
  while (i < re) {
    if (raw[i] === BS) {
      const nb = raw[i + 1];
      if (nb === DQ) {
        if (raw[i + 2] === BS && raw[i + 3] === DQ) {
          value += raw.toString('utf8', segStart, i);
          value += '"';
          i += 4;
          segStart = i;
          continue;
        }
        closed = i;
        break;
      }
      if (nb === NL) {
        value += raw.toString('utf8', segStart, i);
        value += '\n';
        i += 2;
        segStart = i;
        continue;
      }
      if (nb === CRB) {
        value += raw.toString('utf8', segStart, i);
        value += '\n';
        i += (raw[i + 2] === BS && raw[i + 3] === NL) ? 4 : 2;
        segStart = i;
        continue;
      }
      if (nb === BS) { i += 2; continue; }
      if (nb === 0x75) { i += 6; continue; }
      if (nb === 0x74 || nb === 0x62 || nb === 0x66 || nb === 0x2f) { i += 2; continue; }
      throw new NeedFallback();
    }
    i++;
  }
  if (closed === -1) {
    value = '"';
    let j = rs + 2;
    while (j < re) {
      if (raw[j] === BS) {
        const nb = raw[j + 1];
        if (nb === DQ) { value += '"'; j += 2; }
        else if (nb === NL) { value += '\n'; j += 2; }
        else if (nb === CRB) { j += 2; }
        else if (nb === BS) { value += '\\'; j += 2; }
        else if (nb === 0x75) {
          value += String.fromCharCode(parseInt(raw.toString('utf8', j + 2, j + 6), 16));
          j += 6;
        } else if (nb === 0x74) { value += '\t'; j += 2; }
        else if (nb === 0x62) { value += '\b'; j += 2; }
        else if (nb === 0x66) { value += '\f'; j += 2; }
        else if (nb === 0x2f) { value += '/'; j += 2; }
        else throw new NeedFallback();
      } else {
        let k = j;
        while (k < re && raw[k] !== BS) k++;
        value += raw.toString('utf8', j, k);
        j = k;
      }
    }
    return JSON.stringify(value);
  }
  value += raw.toString('utf8', segStart, closed);
  let j = closed + 2;
  while (j < re) {
    if (raw[j] === BS) {
      const nb = raw[j + 1];
      if (nb === DQ) { value += '"'; j += 2; }
      else if (nb === NL) { value += '\n'; j += 2; }
      else if (nb === CRB) { j += 2; }
      else if (nb === BS) { value += '\\'; j += 2; }
      else if (nb === 0x75) {
        value += String.fromCharCode(parseInt(raw.toString('utf8', j + 2, j + 6), 16));
        j += 6;
      } else if (nb === 0x74) { value += '\t'; j += 2; }
      else if (nb === 0x62) { value += '\b'; j += 2; }
      else if (nb === 0x66) { value += '\f'; j += 2; }
      else if (nb === 0x2f) { value += '/'; j += 2; }
      else throw new NeedFallback();
    } else {
      let k = j;
      while (k < re && raw[k] !== BS) k++;
      value += raw.toString('utf8', j, k);
      j = k;
    }
  }
  return JSON.stringify(value);
}

// Emit one field's JSON value to out at o.
// cs/ce are the fast-copy content range; rs/re + quoted are for slow decode.
function emitField(raw, cs, ce, rs, re, quoted, slow, out, o) {
  if (slow) {
    const fj = slowFieldJSON(raw, rs, re, quoted);
    return o + out.write(fj, o, 'utf8');
  }
  out[o++] = DQ;
  o = copyRange(raw, cs, ce, out, o);
  out[o++] = DQ;
  return o;
}

// Transcode one case. Returns the new write position. Throws NeedFallback.
export function transcodeCase(raw, scanner, ts, te, header, out, o) {
  const { u32, alignBase } = scanner;
  let p = ts;
  if (p + 2 < te && raw[p] === 0xef && raw[p + 1] === 0xbb && raw[p + 2] === 0xbf) p += 3;

  let line = 1;
  let width = -1;
  let rowsEmitted = 0;
  let errors = '';
  let errorsN = 0;

  // {"columns":
  out[o++] = 0x7b;
  out[o++] = DQ; out[o++] = 0x63; out[o++] = 0x6f; out[o++] = 0x6c; out[o++] = 0x75; out[o++] = 0x6d; out[o++] = 0x6e; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a;
  let needColumns = false;
  let rowsOpen = false;
  let firstRow = true;
  if (!header) {
    out[o++] = 0x6e; out[o++] = 0x75; out[o++] = 0x6c; out[o++] = 0x6c;
    out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
    rowsOpen = true;
  } else {
    needColumns = true;
  }

  // Main record loop.
  while (true) {
    while (p < te) {
      if (raw[p] === BS && raw[p + 1] === NL) { p += 2; line++; }
      else if (raw[p] === BS && raw[p + 1] === CRB && raw[p + 2] === BS && raw[p + 3] === NL) { p += 4; line++; }
      else break;
    }
    if (p >= te) break;

    const recordLine = line;
    const recordIsColumns = header && needColumns;
    const recordRow = recordIsColumns ? null : rowsEmitted;

    // Open the record array in the output.
    if (recordIsColumns) {
      // columns array opens right after {"columns":
      out[o++] = 0x5b;
    } else {
      if (!rowsOpen) {
        out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
        rowsOpen = true;
        firstRow = true;
      }
      if (!firstRow) out[o++] = CM;
      firstRow = false;
      out[o++] = 0x5b;
    }

    // Parse + emit this record's fields directly.
    let fieldCount = 0;
    let fieldStart = p;
    let extraJson = '';
    let extraN = 0;
    let firstFieldEmpty = false;
    let firstFieldQuoted = false;
    // Remember where this record's '[' is, so a discarded record can be
    // rewound (only the separator/comma bookkeeping matters: the record
    // is the last thing written, so rewind o to the '[' position).
    const recOpenPos = o - 1;

    while (true) {
      const quoted = raw[fieldStart] === BS && raw[fieldStart + 1] === DQ;
      let slow = false;
      let cs, ce, rs, re;
      let endKind; // 0 comma, 1 line break, 2 END
      if (!quoted) {
        rs = fieldStart;
        let scan = fieldStart;
        let endPos = -1;
        while (true) {
          const d = findDelim(raw, u32, alignBase, scan, te);
          if (d >= te) { endPos = te; endKind = 2; break; }
          if (raw[d] === CM) { endPos = d; endKind = 0; break; }
          const nb = raw[d + 1];
          if (nb === NL) { endPos = d; endKind = 1; break; }
          if (nb === CRB) {
            const isCRLF = raw[d + 2] === BS && raw[d + 3] === NL;
            if (isCRLF) { endPos = d; endKind = 1; break; }
            errors += (errorsN++ ? ',' : '') + '{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}';
            slow = true;
            scan = d + 2;
            continue;
          }
          if (nb === DQ) { scan = d + 2; continue; }
          throw new NeedFallback();
        }
        cs = fieldStart;
        ce = endPos;
        re = endPos;
        // Emit this field (or collect into extra when over width).
        if (fieldCount === 0) { firstFieldEmpty = (fieldStart === endPos); firstFieldQuoted = false; }
        if (!recordIsColumns && width >= 0 && fieldCount >= width) {
          const fj = slow ? slowFieldJSON(raw, rs, re, false) : '"' + raw.toString('utf8', cs, ce) + '"';
          if (extraN > 0) extraJson += ',';
          extraJson += fj;
          extraN++;
        } else {
          if (fieldCount > 0) out[o++] = CM;
          o = emitField(raw, cs, ce, rs, re, false, slow, out, o);
        }
        fieldCount++;
        if (endKind === 0) { fieldStart = endPos + 1; continue; }
        if (endKind === 1) {
          if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
          else { p = endPos + 4; line++; }
        } else { p = te; }
        break;
      }

      // Quoted field.
      rs = fieldStart;
      const openLine = line;
      let scan = fieldStart + 2;
      let contentEnd = -1;
      let closePos = -1;
      let unterminated = false;
      while (true) {
        const d = findDelim(raw, u32, alignBase, scan, te);
        if (d >= te) { unterminated = true; break; }
        if (raw[d] === CM) { scan = d + 1; continue; }
        const nb = raw[d + 1];
        if (nb === DQ) {
          const doubled = raw[d + 2] === BS && raw[d + 3] === DQ;
          if (doubled) { slow = true; scan = d + 4; continue; }
          closePos = d;
          contentEnd = d;
          break;
        }
        if (nb === NL) { slow = true; line++; scan = d + 2; continue; }
        if (nb === CRB) {
          slow = true; line++;
          scan = (raw[d + 2] === BS && raw[d + 3] === NL) ? d + 4 : d + 2;
          continue;
        }
        throw new NeedFallback();
      }
      if (unterminated) {
        errors += (errorsN++ ? ',' : '') + '{"code":"unterminated_quote","line":' + recordLine + ',"row":' + recordRow + '}';
        line = openLine;
        let scan2 = fieldStart + 2;
        let endPos = -1;
        let endKind2 = 2;
        while (true) {
          const d = findDelim(raw, u32, alignBase, scan2, te);
          if (d >= te) { endPos = te; endKind2 = 2; break; }
          if (raw[d] === CM) { endPos = d; endKind2 = 0; break; }
          const nb = raw[d + 1];
          if (nb === NL) { endPos = d; endKind2 = 1; break; }
          if (nb === CRB) {
            const isCRLF = raw[d + 2] === BS && raw[d + 3] === NL;
            if (isCRLF) { endPos = d; endKind2 = 1; break; }
            errors += (errorsN++ ? ',' : '') + '{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}';
            slow = true;
            scan2 = d + 2;
            continue;
          }
          if (nb === DQ) { scan2 = d + 2; continue; }
          throw new NeedFallback();
        }
        cs = fieldStart; ce = endPos; re = endPos;
        if (fieldCount === 0) { firstFieldEmpty = false; firstFieldQuoted = true; }
        if (!recordIsColumns && width >= 0 && fieldCount >= width) {
          const fj = slowFieldJSON(raw, rs, re, true);
          if (extraN > 0) extraJson += ',';
          extraJson += fj;
          extraN++;
        } else {
          if (fieldCount > 0) out[o++] = CM;
          o = emitField(raw, cs, ce, rs, re, true, true, out, o);
        }
        fieldCount++;
        if (endKind2 === 0) { fieldStart = endPos + 1; continue; }
        if (endKind2 === 1) {
          if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
          else { p = endPos + 4; line++; }
        } else { p = te; }
        break;
      }
      cs = fieldStart + 2;
      ce = contentEnd;
      let after = closePos + 2;
      let endPos = -1;
      endKind = 2;
      let hasJunk = false;
      if (after >= te) {
        endPos = te; endKind = 2;
      } else if (raw[after] === CM) {
        endPos = after; endKind = 0;
      } else if (raw[after] === BS && raw[after + 1] === NL) {
        endPos = after; endKind = 1;
      } else if (raw[after] === BS && raw[after + 1] === CRB && raw[after + 2] === BS && raw[after + 3] === NL) {
        endPos = after; endKind = 1;
      } else {
        hasJunk = true;
        slow = true;
        let scan2 = after;
        while (true) {
          const d = findDelim(raw, u32, alignBase, scan2, te);
          if (d >= te) { endPos = te; endKind = 2; break; }
          if (raw[d] === CM) { endPos = d; endKind = 0; break; }
          const nb = raw[d + 1];
          if (nb === NL) { endPos = d; endKind = 1; break; }
          if (nb === CRB) {
            const isCRLF = raw[d + 2] === BS && raw[d + 3] === NL;
            if (isCRLF) { endPos = d; endKind = 1; break; }
            errors += (errorsN++ ? ',' : '') + '{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}';
            scan2 = d + 2;
            continue;
          }
          if (nb === DQ) { scan2 = d + 2; continue; }
          throw new NeedFallback();
        }
      }
      re = endPos;
      if (fieldCount === 0) { firstFieldEmpty = false; firstFieldQuoted = true; }
      if (hasJunk) {
        let junkLen = endPos - after;
        let k = after;
        let stray = 0;
        while (k < endPos) {
          if (raw[k] === BS && raw[k + 1] === CRB) {
            const isCRLF = raw[k + 2] === BS && raw[k + 3] === NL;
            if (!isCRLF) { stray++; k += 2; continue; }
          }
          k++;
        }
        junkLen -= stray * 2;
        if (junkLen > 0) {
          errors += (errorsN++ ? ',' : '') + '{"code":"quote_junk","line":' + recordLine + ',"row":' + recordRow + '}';
        }
      }
      if (!recordIsColumns && width >= 0 && fieldCount >= width) {
        const fj = slowFieldJSON(raw, rs, re, true);
        if (extraN > 0) extraJson += ',';
        extraJson += fj;
        extraN++;
      } else {
        if (fieldCount > 0) out[o++] = CM;
        o = emitField(raw, cs, ce, rs, re, true, slow, out, o);
      }
      fieldCount++;
      if (endKind === 0) { fieldStart = endPos + 1; continue; }
      if (endKind === 1) {
        if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
        else { p = endPos + 4; line++; }
      } else { p = te; }
      break;
    }

    // Close the record array.
    out[o++] = 0x5d; // ]

    // Discard rule: one empty unquoted field -> rewind the record.
    // (Applies to the columns record too: it stays "needed" and the next
    // record becomes the columns, matching the reference.)
    if (fieldCount === 1 && firstFieldEmpty && !firstFieldQuoted) {
      // Rewind o to before the record's '['. If a ',' separator was
      // written before it (not the first row), remove that too.
      if (out[recOpenPos - 1] === CM) {
        o = recOpenPos - 1;
        // firstRow stays false: earlier rows still exist.
      } else {
        o = recOpenPos;
        firstRow = true; // no rows written yet.
      }
      continue;
    }
    if (recordIsColumns) {
      if (width < 0) width = fieldCount;
      needColumns = false;
      out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
      rowsOpen = true;
      firstRow = true;
      continue;
    }
    if (width < 0) width = fieldCount;
    if (fieldCount < width) {
      errors += (errorsN++ ? ',' : '') + '{"code":"short_row","line":' + recordLine + ',"row":' + recordRow + ',"fields":' + fieldCount + '}';
      // Pad: back up over ']' and append ,"",... then ']'.
      o -= 1;
      for (let f = fieldCount; f < width; f++) { out[o++] = CM; out[o++] = DQ; out[o++] = DQ; }
      out[o++] = 0x5d;
    } else if (fieldCount > width) {
      errors += (errorsN++ ? ',' : '') + '{"code":"long_row","line":' + recordLine + ',"row":' + recordRow + ',"extra":[' + extraJson + ']}';
    }
    rowsEmitted++;
  }

  // Close the case JSON.
  if (needColumns) {
    out[o++] = 0x5b; out[o++] = 0x5d;
  }
  if (!rowsOpen) {
    out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
  }
  out[o++] = 0x5d; out[o++] = CM; out[o++] = DQ; out[o++] = 0x65; out[o++] = 0x72; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x72; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
  o += out.write(errors, o, 'utf8');
  out[o++] = 0x5d;
  out[o++] = 0x7d;
  return o;
}
