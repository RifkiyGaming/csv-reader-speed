// csv-reader-speed: a fast drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Written from scratch against the reference's
// documented policy (BOM drop, LF/CRLF record ends, stray_cr, quoted-field
// rules with doubled quotes, quote_junk, unterminated_quote, short_row /
// long_row padding and cutting, {code, line, row} errors in the order met).
//
// Speed comes from never building a field one character at a time:
//  - a record line with no quote and no stray CR is split(',') in one go
//    (the common case for plain numeric / word / code columns);
//  - unquoted fields are scanned with charCodeAt and taken out with one
//    slice, inlined in the record loop so a field costs a scan and a slice,
//    not a call and a result object;
//  - quoted fields jump from quote to quote with indexOf, and only the
//    rare segment holding a line break is walked character by character;
//  - line counting is done from the same scans, never with a second pass.

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
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the character at pos is on

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; `added` counts the characters kept (so quote_junk only fires when
  // the junk after a closing quote actually added characters). Used only for
  // the rare paths (the junk after a closing quote, the unterminated re-read);
  // the record loop below inlines this same scan for plain fields.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        // '\n'
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === 13) {
        // '\r'
        if (text.charCodeAt(pos + 1) === 10) {
          value += text.slice(start, pos);
          added += pos - start;
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        error('stray_cr');
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(start, pos);
    added += pos - start;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos); // the next quote (or -1: never closes)
      if (q === -1) break;
      // The segment [pos, q): plain text unless it holds a line break.
      const nl = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      if ((nl === -1 || nl >= q) && (cr === -1 || cr >= q)) {
        value += text.slice(pos, q);
      } else {
        // A CRLF or lone CR inside quotes is one LF; every LF, CRLF and lone
        // CR inside quotes counts one line.
        let s = pos;
        let part = '';
        for (;;) {
          const iN = text.indexOf('\n', s);
          const iR = text.indexOf('\r', s);
          let i = -1;
          let isCR = false;
          if (iR !== -1 && iR < q && (iN === -1 || iN >= q || iR < iN)) {
            i = iR;
            isCR = true;
          } else if (iN !== -1 && iN < q) {
            i = iN;
          }
          if (i === -1) {
            part += text.slice(s, q);
            break;
          }
          part += text.slice(s, i);
          part += '\n';
          line += 1;
          s = isCR && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
        }
        value += part;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote, and the field goes on.
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
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
    // Fast path: the record's first line holds no quote, so no field can span
    // a line and no field is quoted. When it also holds no stray CR (only a
    // trailing CR of a CRLF ending, if any), the whole record is one split.
    // The quote test runs on the whole text first, so a quoted record never
    // pays for the slice below; only a quoteless record is sliced to test
    // for a stray CR.
    const lf = text.indexOf('\n', pos);
    const segEnd = lf === -1 ? n : lf;
    const q = text.indexOf('"', pos);
    const seg = q !== -1 && q < segEnd ? null : text.slice(pos, segEnd);
    const cr = seg === null ? -1 : seg.indexOf('\r');
    if (seg !== null && (cr === -1 || (lf !== -1 && cr === seg.length - 1))) {
      fields = cr === -1 ? seg.split(',') : seg.slice(0, -1).split(',');
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
    } else {
      // Slow path: field by field, as the reference reads them. The unquoted
      // scan is inlined here (same scan as readUnquoted, no call, no result
      // object); quoted fields go through readQuoted.
      fields = [];
      let ended = COMMA;
      let quoted = false;
      for (;;) {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          const field = readQuoted();
          fields.push(field.value);
          ended = field.ended;
        } else {
          quoted = false;
          let value = '';
          let start = pos;
          let done = false;
          while (!done && pos < n) {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              value += text.slice(start, pos);
              pos += 1;
              ended = COMMA;
              done = true;
            } else if (c === 10) {
              value += text.slice(start, pos);
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
              done = true;
            } else if (c === 13) {
              if (text.charCodeAt(pos + 1) === 10) {
                value += text.slice(start, pos);
                pos += 2;
                line += 1;
                ended = LINE_BREAK;
                done = true;
              } else {
                error('stray_cr');
                value += text.slice(start, pos);
                pos += 1;
                start = pos;
              }
            } else {
              pos += 1;
            }
          }
          if (!done) {
            value += text.slice(start, pos);
            ended = END;
          }
          fields.push(value);
        }
        if (ended !== COMMA) break;
      }

      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

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
