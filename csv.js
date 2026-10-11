// Minimal RFC 4180 CSV parser (no dependency). Pure: text in, records out.
//
// Handles comma-separated fields, double-quoted fields containing commas, quotes (""),
// and newlines, LF / CRLF line endings, and a UTF-8 BOM at the start. Blank lines are
// skipped. A quote in the middle of an unquoted field is kept as a literal character.
//
// Returns [{ line, fields }] where `line` is the 1-based line the record starts on, so
// callers can report errors against the line a spreadsheet user would see.

export function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const records = [];
  let fields = [];
  let field = '';
  let quoted = false; // the current field was opened with a quote
  let inQuotes = false;
  let atFieldStart = true;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    quoted = false;
    atFieldStart = true;
  };

  const endRecord = () => {
    const wasQuoted = quoted;
    endField();
    const blank = fields.length === 1 && fields[0] === '' && !wasQuoted;
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      quoted = true;
      atFieldStart = false;
      quoteLine = line;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }

  if (inQuotes) throw new Error(`line ${quoteLine}: quoted field is never closed`);
  if (field !== '' || fields.length > 0 || quoted) endRecord();

  return records;
}
