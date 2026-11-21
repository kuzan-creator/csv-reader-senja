// transcode.js — byte-level JSON-to-JSON transcoder for csv-reader 1.0.0.
//
// Reads one case straight from the raw cases.json bytes and writes that
// case's answer JSON straight into a preallocated output Buffer. It never
// builds the decoded CSV text, never builds field strings for the common
// case, and never calls JSON.parse / JSON.stringify for the case it
// handles: the field bytes in the input JSON are already JSON-escaped, and
// csv-reader's own escaping of a field value is the same escaping, so a
// field that needs no CSV-level change is copied byte-for-byte from the
// input Buffer to the output Buffer.
//
// Shape: per record the parser collects field descriptors (byte ranges +
// flags) into a small reused array, then the emitter writes the record's
// JSON from those descriptors. Separating parsing from emission is what
// makes short/long rows, the discard rule and columns-vs-rows easy to get
// right. Delimiters are found with a SWAR scan (four bytes per integer
// op, looking for backslash and comma); the only per-field work is finding
// its end and copying it. Everything that changes bytes — doubled quotes,
// CR to LF inside quotes, stray CRs, quote junk, unterminated quotes —
// is rare, so those fields take a slow byte-level decode and the common
// field is a single copy.
//
// Escapes in the input JSON: the generator only ever emits \"  \n  \r
// (measured on the practice set: 300724 / 77715 / 40285, zero \\ and zero
// \u). Any other escape (\\, \u, \t, ...) throws NeedFallback and the
// caller answers that case with JSON.parse + solve.js run() instead, so
// correctness never depends on the fast path covering an odd input.
//
// CSV rules kept exactly (from baselines/csv-reader index.js): BOM dropped;
// a line left with no characters is no record; a record that parses to one
// empty unquoted field is discarded (its stray_cr errors stay); CR outside
// quotes not followed by LF is dropped (stray_cr); a quoted field runs to
// the next non-doubled quote, "" is one quote, CRLF / lone CR inside is LF
// (+1 line), LF inside is +1 line; after the closing quote the characters
// up to the next comma / line break are appended as-is (quote_junk, only if
// >=1 char kept, stray_cr inside the junk emitted before quote_junk); a
// quote that never closes is a literal first char and the rest is re-read
// as unquoted (unterminated_quote, emitted before errors from the re-read,
// line counter reset to the field's opening line); a quote inside an
// unquoted field is literal; columns / width / short_row / long_row and the
// error order / line / row are exactly the reference's.

export class NeedFallback extends Error {}

const BS = 0x5c; // backslash
const CM = 0x2c; // comma
const DQ = 0x22; // double quote
const NL = 0x6e; // 'n' (byte after \ for LF)
const CRB = 0x72; // 'r' (byte after \ for CR)

// SWAR: a 32-bit mask with 0x80 set in the high bit of every byte that is
// a backslash (0x5C) or a comma (0x2C). Zero means the four bytes hold no
// delimiter at all.
function delimMask(w) {
  const a = w ^ 0x5c5c5c5c;
  const b = w ^ 0x2c2c2c2c;
  return ((a - 0x01010101) & ~a & 0x80808080) | ((b - 0x01010101) & ~b & 0x80808080);
}

// One scanner for the whole cases.json Buffer: a Uint32Array view over it
// so the hot loop reads four bytes per array access. alignBase is the raw
// index of u32[0].
export function makeScanner(raw) {
  const base = raw.byteOffset;
  const align = (4 - (base % 4)) % 4;
  const u32 = new Uint32Array(raw.buffer, base + align, (raw.length - align) >>> 2);
  return { u32, alignBase: align };
}

// Find the next backslash or comma at or after pos, before end.
// Returns the position, or end when there is none. SWAR over u32 words;
// the first and last words are masked to [pos, end).
//
// NOTE: the SWAR zero-byte test ((x - 0x01010101) & ~x & 0x80808080)
// has a borrow false positive: a 0x00 byte followed by a 0x01 byte
// (here: a ',' followed by '-', or a '\' followed by ']') flags the
// second byte too. So every candidate is verified against the raw byte
// and a false positive is skipped and the search resumes after it.
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

// Copy raw[s..e) to out at o, byte by byte. A manual loop beats
// Buffer.copy for the short fields this workload is made of (measured:
// 17.5 ms vs 49.9 ms for 800k 12-byte fields) and takes no allocation.
function copyRange(raw, s, e, out, o) {
  for (let i = s; i < e; i++) out[o++] = raw[i];
  return o;
}

// Decode one slow field's raw bytes [rs, re) into its JSON string.
// `quoted` says the field opened with a quote (so rs is the opening \").
// Mirrors the reference parser's readQuoted / readUnquoted on raw bytes.
// Only used for fields that need a CSV-level change (doubled quotes,
// CR to LF, stray CRs, junk, unterminated quotes) — rare by construction.
function slowFieldJSON(raw, rs, re, quoted) {
  let value = '';
  if (!quoted) {
    // Unquoted: decode escapes, drop stray CRs (a CR not followed by LF).
    let i = rs;
    while (i < re) {
      if (raw[i] === BS) {
        const nb = raw[i + 1];
        if (nb === DQ) { value += '"'; i += 2; }
        else if (nb === NL) { value += '\n'; i += 2; }
        else if (nb === CRB) {
          // Lone CR (a CRLF here would have ended the field): drop it.
          i += 2;
        } else if (nb === BS) { value += '\\'; i += 2; }
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
  // Quoted: rs is the opening \". Find the closing quote (a \" not
  // followed by \"), decoding the content as we go.
  let i = rs + 2;
  let closed = -1;
  let segStart = i;
  while (i < re) {
    if (raw[i] === BS) {
      const nb = raw[i + 1];
      if (nb === DQ) {
        if (raw[i + 2] === BS && raw[i + 3] === DQ) {
          // Doubled quote: "" is one quote.
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
        // CRLF or lone CR: one LF either way.
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
    // Unterminated: the quote is a literal first char and the rest is
    // re-read as unquoted. The content after the opening quote is that
    // unquoted rest (its escapes decode as unquoted, stray CRs dropped).
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
  // Closed: content up to the closing quote, then junk after it.
  value += raw.toString('utf8', segStart, closed);
  // Junk: raw bytes after the closing quote (closed+2) to re, decoded as
  // unquoted (stray CRs dropped). Only when there is junk.
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

// Field descriptor layout in the reused Int32Array (5 ints per field):
//   0 cs: content start (raw index, for the fast copy)
//   1 ce: content end (raw index, exclusive)
//   2 rs: raw start (for the slow decode)
//   3 re: raw end (exclusive)
//   4 flags: bit 0 = quoted, bit 1 = slow (needs slowFieldJSON)
const DESC_STRIDE = 5;
const F_QUOTED = 1;
const F_SLOW = 2;
const DESC_CAP = 256; // max fields per record; more falls back
const desc = new Int32Array(DESC_CAP * DESC_STRIDE);

// Transcode one case. raw is the cases.json Buffer, scanner is from
// makeScanner(raw), ts/te bound the raw JSON-escaped text bytes,
// header is the case's header flag, out is the output Buffer, o is the
// write position. Returns the new write position. Throws NeedFallback
// when the case needs the safe parser.
export function transcodeCase(raw, scanner, ts, te, header, out, o) {
  const { u32, alignBase } = scanner;
  let p = ts;
  if (p + 2 < te && raw[p] === 0xef && raw[p + 1] === 0xbb && raw[p + 2] === 0xbf) p += 3;

  let line = 1;
  let width = -1;
  let rowsEmitted = 0;
  const errors = [];

  // {"columns":
  out[o++] = 0x7b;
  const COLS = [0x22, 0x63, 0x6f, 0x6c, 0x75, 0x6d, 0x6e, 0x73, 0x22, 0x3a];
  for (let i = 0; i < COLS.length; i++) out[o++] = COLS[i];
  let needColumns = false;
  let rowsOpen = false;
  let firstRow = true;
  if (!header) {
    out[o++] = 0x6e; out[o++] = 0x75; out[o++] = 0x6c; out[o++] = 0x6c; // null
    // ,"rows":[
    out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
    rowsOpen = true;
  } else {
    needColumns = true;
  }

  // Emit one record's JSON array from its descriptors (fieldCount fields).
  // `isColumns` says it is the header. Handles short/long rows and the
  // long_row extra list. Returns nothing; advances o.
  function emitRecord(fieldCount, isColumns) {
    out[o++] = 0x5b; // [
    let extraJson = '';
    let extraN = 0;
    const limit = isColumns ? fieldCount : (width < 0 ? fieldCount : width);
    for (let f = 0; f < fieldCount; f++) {
      const b = f * DESC_STRIDE;
      const cs = desc[b], ce = desc[b + 1], rs = desc[b + 2], re = desc[b + 3], fl = desc[b + 4];
      if (!isColumns && width >= 0 && f >= width) {
        // Extra field (long row): into the extra list, not the record.
        const fj = (fl & F_SLOW) ? slowFieldJSON(raw, rs, re, !!(fl & F_QUOTED)) : '"' + raw.toString('utf8', cs, ce) + '"';
        if (extraN > 0) extraJson += ',';
        extraJson += fj;
        extraN++;
        continue;
      }
      if (f > 0) out[o++] = CM;
      if (fl & F_SLOW) {
        const fj = slowFieldJSON(raw, rs, re, !!(fl & F_QUOTED));
        o += out.write(fj, o, 'utf8');
      } else {
        out[o++] = DQ;
        o = copyRange(raw, cs, ce, out, o);
        out[o++] = DQ;
      }
    }
    out[o++] = 0x5d; // ]
    if (isColumns) return;
    if (width < 0) width = fieldCount;
    if (fieldCount < width) {
      errors.push('{"code":"short_row","line":' + recordLine + ',"row":' + recordRow + ',"fields":' + fieldCount + '}');
      // Pad: back up over ']' and append ,"",... then ']'.
      o -= 1;
      for (let f = fieldCount; f < width; f++) { out[o++] = CM; out[o++] = DQ; out[o++] = DQ; }
      out[o++] = 0x5d;
    } else if (fieldCount > width) {
      errors.push('{"code":"long_row","line":' + recordLine + ',"row":' + recordRow + ',"extra":[' + extraJson + ']}');
    }
    rowsEmitted++;
  }

  let recordLine = 1;
  let recordRow = null;

  // Main record loop.
  while (true) {
    // Skip blank lines (LF or CRLF at p).
    while (p < te) {
      if (raw[p] === BS && raw[p + 1] === NL) { p += 2; line++; }
      else if (raw[p] === BS && raw[p + 1] === CRB && raw[p + 2] === BS && raw[p + 3] === NL) { p += 4; line++; }
      else break;
    }
    if (p >= te) break;

    recordLine = line;
    recordRow = (header && needColumns) ? null : rowsEmitted;
    const recordIsColumns = header && needColumns;

    // Parse this record's fields into desc.
    let fieldCount = 0;
    let fieldStart = p;
    let recEnd = 0; // 0 = comma continues, 1 = line break ends, 2 = END
    let firstFieldEmpty = false;
    let firstFieldQuoted = false;

    while (true) {
      if (fieldCount >= DESC_CAP) throw new NeedFallback();
      const b = fieldCount * DESC_STRIDE;
      // Is this field quoted? It opens with \" at fieldStart.
      const quoted = raw[fieldStart] === BS && raw[fieldStart + 1] === DQ;
      let slow = false;
      let cs, ce, rs, re;
      let endKind; // 0 comma, 1 line break, 2 END
      if (!quoted) {
        // Unquoted field: scan for the next delimiter.
        rs = fieldStart;
        let scan = fieldStart;
        let endPos = -1;
        let endIsComma = false;
        while (true) {
          const d = findDelim(raw, u32, alignBase, scan, te);
          if (d >= te) { endPos = te; endKind = 2; break; }
          if (raw[d] === CM) { endPos = d; endKind = 0; endIsComma = true; break; }
          // Backslash.
          const nb = raw[d + 1];
          if (nb === NL) { endPos = d; endKind = 1; break; }
          if (nb === CRB) {
            const isCRLF = raw[d + 2] === BS && raw[d + 3] === NL;
            if (isCRLF) { endPos = d; endKind = 1; break; }
            // Lone CR: stray_cr, drop it, field continues.
            errors.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
            slow = true;
            scan = d + 2;
            continue;
          }
          if (nb === DQ) {
            // Literal quote inside an unquoted field: content. The raw
            // \" is already the right JSON escaping, so no slow flag.
            scan = d + 2;
            continue;
          }
          throw new NeedFallback();
        }
        cs = fieldStart;
        ce = endPos;
        re = endPos;
        // A stray CR inside makes it slow (segments must drop the CR).
        // The slow decoder re-scans [rs, re) and drops lone CRs.
        desc[b] = cs; desc[b + 1] = ce; desc[b + 2] = rs; desc[b + 3] = re;
        desc[b + 4] = (quoted ? F_QUOTED : 0) | (slow ? F_SLOW : 0);
        fieldCount++;
        if (fieldCount === 1) { firstFieldEmpty = (fieldStart === endPos); firstFieldQuoted = false; }
        if (endKind === 0) { fieldStart = endPos + 1; continue; }
        if (endKind === 1) {
          // Line break: LF is 2 bytes, CRLF is 4.
          if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
          else { p = endPos + 4; line++; }
          recEnd = 1;
        } else {
          p = te;
          recEnd = 2;
        }
        break;
      }

      // Quoted field.
      rs = fieldStart;
      const openLine = line;
      let scan = fieldStart + 2;
      let contentEnd = -1; // raw index of the closing \" (its backslash)
      let closePos = -1;
      let unterminated = false;
      while (true) {
        const d = findDelim(raw, u32, alignBase, scan, te);
        if (d >= te) { unterminated = true; break; }
        if (raw[d] === CM) {
          // Comma inside quotes is content; keep scanning.
          scan = d + 1;
          continue;
        }
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
        // The quote is a literal first char and the rest is re-read as
        // unquoted. The field runs to the next comma / line break / END.
        errors.push('{"code":"unterminated_quote","line":' + recordLine + ',"row":' + recordRow + '}');
        line = openLine;
        // Re-read as unquoted starting just after the opening quote.
        // The value is '"' + the unquoted rest. Scan the rest for its end.
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
            errors.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
            slow = true;
            scan2 = d + 2;
            continue;
          }
          if (nb === DQ) { scan2 = d + 2; continue; }
          throw new NeedFallback();
        }
        // The field's raw range is the whole thing from the opening
        // quote to the end; slow decode rebuilds '"' + rest.
        cs = fieldStart; ce = endPos; re = endPos;
        desc[b] = cs; desc[b + 1] = ce; desc[b + 2] = rs; desc[b + 3] = re;
        desc[b + 4] = F_QUOTED | F_SLOW;
        fieldCount++;
        if (fieldCount === 1) { firstFieldEmpty = false; firstFieldQuoted = true; }
        if (endKind2 === 0) { fieldStart = endPos + 1; continue; }
        if (endKind2 === 1) {
          if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
          else { p = endPos + 4; line++; }
          recEnd = 1;
        } else { p = te; recEnd = 2; }
        break;
      }
      // Closed. Content is [fieldStart+2, contentEnd).
      cs = fieldStart + 2;
      ce = contentEnd;
      // What follows the closing quote (closePos+2)?
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
        // Junk: scan for the next comma / line break / END.
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
            errors.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
            scan2 = d + 2;
            continue;
          }
          if (nb === DQ) { scan2 = d + 2; continue; }
          throw new NeedFallback();
        }
      }
      re = endPos;
      desc[b] = cs; desc[b + 1] = ce; desc[b + 2] = rs; desc[b + 3] = re;
      desc[b + 4] = F_QUOTED | (slow ? F_SLOW : 0);
      fieldCount++;
      if (fieldCount === 1) { firstFieldEmpty = false; firstFieldQuoted = true; }
      // quote_junk: reported when the field ends, only if >=1 char kept.
      if (hasJunk) {
        // Junk kept = the raw bytes after the closing quote up to endPos,
        // minus any stray CRs dropped. Count kept chars: if the junk
        // region is non-empty after dropping stray CRs, it is junk.
        // Compute kept length: junk bytes minus 2 per stray CR inside.
        let junkLen = endPos - after;
        // Count stray CRs in the junk region.
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
          errors.push('{"code":"quote_junk","line":' + recordLine + ',"row":' + recordRow + '}');
        }
      }
      if (endKind === 0) { fieldStart = endPos + 1; continue; }
      if (endKind === 1) {
        if (raw[endPos + 1] === NL) { p = endPos + 2; line++; }
        else { p = endPos + 4; line++; }
        recEnd = 1;
      } else { p = te; recEnd = 2; }
      break;
    }

    // Discard rule: one empty unquoted field.
    if (fieldCount === 1 && firstFieldEmpty && !firstFieldQuoted) {
      continue;
    }
    if (recordIsColumns) {
      if (width < 0) width = fieldCount;
      // Emit the columns array: '[' ... ']' (no short/long, no row count).
      out[o++] = 0x5b;
      for (let f = 0; f < fieldCount; f++) {
        const b = f * DESC_STRIDE;
        const cs = desc[b], ce = desc[b + 1], rs = desc[b + 2], re = desc[b + 3], fl = desc[b + 4];
        if (f > 0) out[o++] = CM;
        if (fl & F_SLOW) {
          const fj = slowFieldJSON(raw, rs, re, !!(fl & F_QUOTED));
          o += out.write(fj, o, 'utf8');
        } else {
          out[o++] = DQ;
          o = copyRange(raw, cs, ce, out, o);
          out[o++] = DQ;
        }
      }
      out[o++] = 0x5d;
      needColumns = false;
      // ,"rows":[
      out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
      rowsOpen = true;
      firstRow = true;
    } else {
      if (!rowsOpen) {
        // Header false wrote null + rows already; header true with no
        // columns yet cannot happen here (needColumns handled above).
        out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
        rowsOpen = true;
        firstRow = true;
      }
      if (!firstRow) out[o++] = CM;
      firstRow = false;
      emitRecord(fieldCount, false);
    }
  }

  // Close the case JSON.
  if (needColumns) {
    out[o++] = 0x5b; out[o++] = 0x5d; // []
  }
  if (!rowsOpen) {
    out[o++] = CM; out[o++] = DQ; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x77; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
  }
  // ],"errors":[
  out[o++] = 0x5d; out[o++] = CM; out[o++] = DQ; out[o++] = 0x65; out[o++] = 0x72; out[o++] = 0x72; out[o++] = 0x6f; out[o++] = 0x72; out[o++] = 0x73; out[o++] = DQ; out[o++] = 0x3a; out[o++] = 0x5b;
  for (let i = 0; i < errors.length; i++) {
    if (i > 0) out[o++] = CM;
    o += out.write(errors[i], o, 'utf8');
  }
  out[o++] = 0x5d; // ]
  out[o++] = 0x7d; // }
  return o;
}
