// CSV Senja — a fast drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The reference reads one character at a time and builds
// every field a character at a time; this reader keeps every one of its rules
// (BOM, empty lines, stray CRs, quoted fields, doubled quotes, quote junk,
// unterminated quotes, short/long rows, error order and line/row numbers) but
// moves in slices: indexOf finds the next delimiter in native code and slice
// takes a whole field at once, so the common record — no quote anywhere in it —
// is split without ever looking at a character.
//
// Rules, kept exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its field
//     count) or cut (long_row, with extra: the cut fields) to the first record's
//     width; each error is {code, line, row}, in the order met, a record's
//     short_row or long_row when it ends: line the 1-based line its record starts
//     on, counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; `added` counts the characters kept after `value` was passed in.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const nc = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      const nr = text.indexOf('\r', pos);
      let end = n;
      let kind = END;
      if (nc !== -1 && nc < end) {
        end = nc;
        kind = COMMA;
      }
      if (nl !== -1 && nl < end) {
        end = nl;
        kind = LINE_BREAK;
      }
      if (nr !== -1 && nr < end) {
        end = nr;
        kind = 3; // a CR: CRLF ends the field, a lone one is dropped
      }
      if (end > pos) {
        value += text.slice(pos, end);
        added += end - pos;
      }
      if (kind === COMMA) {
        pos = end + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (kind === 3) {
        if (text.charCodeAt(end + 1) === 10) {
          pos = end + 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        error('stray_cr');
        pos = end + 1;
        continue;
      }
      pos = n;
      return { value, ended: END, added };
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote, skipping doubled ones ("").
    const parts = [];
    let segStart = open + 1;
    let q = -1;
    let closed = false;
    while (true) {
      q = text.indexOf('"', segStart);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        parts.push(text.slice(segStart, q), '"');
        segStart = q + 2;
        continue;
      }
      parts.push(text.slice(segStart, q));
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    let value = parts.length === 1 ? parts[0] : parts.join('');
    // CRLF and lone CRs inside quotes are each one LF; every line break
    // inside quotes counts toward the line number.
    if (value.indexOf('\r') !== -1) {
      const out = [];
      let last = 0;
      for (let i = 0; i < value.length; i++) {
        const cc = value.charCodeAt(i);
        if (cc === 13) {
          out.push(value.slice(last, i), '\n');
          line += 1;
          if (value.charCodeAt(i + 1) === 10) i += 1;
          last = i + 1;
        } else if (cc === 10) {
          out.push(value.slice(last, i), '\n');
          line += 1;
          last = i + 1;
        }
      }
      out.push(value.slice(last));
      value = out.join('');
    } else if (value.indexOf('\n') !== -1) {
      let idx = -1;
      while ((idx = value.indexOf('\n', idx + 1)) !== -1) line += 1;
    }
    pos = q + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted;
    // Fast path: the record runs to the next LF and holds no quote at all.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const qpos = text.indexOf('"', pos);
    if (qpos === -1 || qpos >= segEnd) {
      const rpos = text.indexOf('\r', pos);
      if (rpos === -1 || rpos >= segEnd || (nl !== -1 && rpos === segEnd - 1)) {
        // No quote, and no CR except a CRLF at the very end of the record.
        const fieldEnd = nl !== -1 && rpos === segEnd - 1 ? segEnd - 1 : segEnd;
        fields = [];
        quoted = false;
        let start = pos;
        while (true) {
          const c = text.indexOf(',', start);
          if (c === -1 || c >= fieldEnd) {
            fields.push(text.slice(start, fieldEnd));
            break;
          }
          fields.push(text.slice(start, c));
          start = c + 1;
        }
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
      } else {
        // A stray CR sits inside the record: fall through to the slow path.
        fields = null;
      }
    } else {
      fields = null;
    }
    if (fields === null) {
      fields = [];
      quoted = false;
      let ended;
      do {
        quoted = text.charCodeAt(pos) === 34;
        const field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
        ended = field.ended;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
