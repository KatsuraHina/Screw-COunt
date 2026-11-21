// A small .xlsx writer: enough of the format to hand someone a real workbook,
// with no build step and nothing fetched from a CDN.
//
// An .xlsx is a ZIP of XML parts. ZIP allows stored (uncompressed) entries, so
// no deflate implementation is needed — the files here are a few hundred KB at
// worst and go straight into Excel, Google Sheets or Numbers.

// --- ZIP --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8 = (text) => new TextEncoder().encode(text);

// DOS time/date, which is all a ZIP entry records. Anything in range works;
// the file's real timestamp comes from when it lands on disk.
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name, data: Uint8Array }] → one stored-method ZIP archive.
export function zipStore(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = utf8(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), name, entry.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); // central directory header
    dir.setUint16(4, 20, true); // version made by
    dir.setUint16(6, 20, true); // version needed
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, entry.data.length, true);
    dir.setUint32(24, entry.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + entry.data.length;
  });

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const size = all.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  all.forEach((part) => {
    out.set(part, at);
    at += part.length;
  });
  return out;
}

// --- Workbook ---------------------------------------------------------------

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters are not valid in XML at all and would break the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function columnName(index) {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

// Excel counts days from 1899-12-30. Built from the date parts so a sheet
// written at 11pm doesn't land on the next day in another time zone.
export function dateSerial(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

// A colour per section, so one glance tells you which part of the report you
// are in: the heading sits on the strong shade in white, its table header on
// the pale one.
export const PALETTE = {
  summary: { strong: "FF263238", pale: "FFDDE3E6" },
  trusses: { strong: "FF1D4E89", pale: "FFDCE7F5" },
  walls: { strong: "FF1E6B52", pale: "FFD9EDE4" },
  workers: { strong: "FF5B3B8C", pale: "FFE4DCF2" },
  printer: { strong: "FFA85B00", pale: "FFFBE7CC" },
  steelbay: { strong: "FF8A2B2B", pale: "FFF4DCDC" },
  stock: { strong: "FF00636E", pale: "FFD4EAEE" }
};

const PALETTE_KEYS = Object.keys(PALETTE);

// Fills: 0 and 1 are the two Excel expects, then every strong shade, then
// every pale one.
const FILL_OFFSET = 2;
const paleFill = (index) => FILL_OFFSET + PALETTE_KEYS.length + index;

// Cell formats, in the order they are written into styles.xml. The first four
// are the plain ones; after that each section gets a banded and a header
// format, each with a date variant so a dated heading keeps its colour.
const CELL_FORMATS = [
  { font: 0, fill: 0, date: false },
  { font: 1, fill: 0, date: false },
  { font: 0, fill: 0, date: true },
  { font: 1, fill: 0, date: true }
];
const STYLE_INDEX = {};
PALETTE_KEYS.forEach((key, index) => {
  STYLE_INDEX[`band:${key}`] = CELL_FORMATS.length;
  CELL_FORMATS.push({ font: 2, fill: FILL_OFFSET + index, date: false });
  CELL_FORMATS.push({ font: 2, fill: FILL_OFFSET + index, date: true });
  STYLE_INDEX[`head:${key}`] = CELL_FORMATS.length;
  CELL_FORMATS.push({ font: 1, fill: paleFill(index), date: false });
  CELL_FORMATS.push({ font: 1, fill: paleFill(index), date: true });
});

const STYLE_PLAIN = 0;
const STYLE_BOLD = 1;
const STYLE_DATE = 2;
const STYLE_BOLD_DATE = 3;

// The format for a row's style, picking the date variant where needed. The
// two variants of a coloured style sit next to each other, hence the +1.
function styleFor(rowStyle, bold, isDate) {
  const base = rowStyle ? STYLE_INDEX[rowStyle] : undefined;
  if (base !== undefined) {
    return isDate ? base + 1 : base;
  }
  if (isDate) {
    return bold ? STYLE_BOLD_DATE : STYLE_DATE;
  }
  return bold ? STYLE_BOLD : STYLE_PLAIN;
}

function cellXml(ref, value, bold, rowStyle) {
  const blank = value === null || value === undefined || value === "";
  if (blank) {
    // A coloured row still needs its empty cells, or the band stops at the
    // last word instead of running across the table.
    return rowStyle ? `<c r="${ref}" s="${styleFor(rowStyle, bold, false)}"/>` : "";
  }

  if (typeof value === "object" && value.date) {
    const serial = dateSerial(value.date);
    if (serial === null) {
      return (
        `<c r="${ref}" s="${styleFor(rowStyle, bold, false)}" t="inlineStr">` +
        `<is><t>${escapeXml(value.date)}</t></is></c>`
      );
    }
    return `<c r="${ref}" s="${styleFor(rowStyle, bold, true)}"><v>${serial}</v></c>`;
  }

  const style = styleFor(rowStyle, bold, false);

  if (typeof value === "number" && Number.isFinite(value)) {
    // Long decimal tails are noise in a report; two places is plenty.
    return `<c r="${ref}" s="${style}"><v>${Math.round(value * 100) / 100}</v></c>`;
  }

  return (
    `<c r="${ref}" s="${style}" t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  );
}

function sheetXml(sheet) {
  const boldRows = new Set(sheet.boldRows || []);
  const rowStyles = sheet.rowStyles || {};
  const widths = [];

  sheet.rows.forEach((row) => {
    row.forEach((value, column) => {
      const text =
        value && typeof value === "object" && value.date
          ? "0000-00-00"
          : value === null || value === undefined
            ? ""
            : String(value);
      widths[column] = Math.max(widths[column] || 0, text.length);
    });
  });

  const cols = widths.length
    ? `<cols>${widths
        .map(
          (width, index) =>
            `<col min="${index + 1}" max="${index + 1}" width="${Math.min(
              34,
              Math.max(9, width + 2)
            )}" customWidth="1"/>`
        )
        .join("")}</cols>`
    : "";

  const width = widths.length;
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const bold = boldRows.has(rowIndex);
      const rowStyle = rowStyles[rowIndex];
      // A banded row runs the full width of the sheet; everything else stops
      // at its own last cell.
      const cellCount = rowStyle ? Math.max(width, row.length) : row.length;
      let cells = "";
      for (let column = 0; column < cellCount; column += 1) {
        cells += cellXml(`${columnName(column)}${rowIndex + 1}`, row[column], bold, rowStyle);
      }
      return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : "";
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    // The header row stays put while the reader scrolls.
    (sheet.freezeHeader === false
      ? ""
      : `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`) +
    cols +
    `<sheetData>${rows}</sheetData>` +
    `</worksheet>`
  );
}

// Built from the palette rather than written out by hand, so a colour added
// above can't fall out of step with the formats that use it.
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  // White, for a section heading sitting on its strong colour.
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="${FILL_OFFSET + PALETTE_KEYS.length * 2}">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  PALETTE_KEYS.map(
    (key) =>
      `<fill><patternFill patternType="solid"><fgColor rgb="${PALETTE[key].strong}"/>` +
      `<bgColor indexed="64"/></patternFill></fill>`
  ).join("") +
  PALETTE_KEYS.map(
    (key) =>
      `<fill><patternFill patternType="solid"><fgColor rgb="${PALETTE[key].pale}"/>` +
      `<bgColor indexed="64"/></patternFill></fill>`
  ).join("") +
  `</fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="${CELL_FORMATS.length}">` +
  CELL_FORMATS.map(
    (format) =>
      `<xf numFmtId="${format.date ? 164 : 0}" fontId="${format.font}" fillId="${format.fill}" ` +
      `borderId="0" xfId="0"${format.date ? ' applyNumberFormat="1"' : ""}` +
      `${format.font ? ' applyFont="1"' : ""}${format.fill ? ' applyFill="1"' : ""}/>`
  ).join("") +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

// Excel rejects these in a tab name, and a name can't be longer than 31.
export function safeSheetName(name, taken = new Set()) {
  let clean = String(name).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = clean;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// sheets: [{ name, rows: [[value, …]], boldRows?: [index] }] → .xlsx bytes.
// A value is a string, a number, { date: "YYYY-MM-DD" }, or null for a blank.
export function buildXlsx(sheets, now = new Date()) {
  const taken = new Set();
  const named = sheets.map((sheet) => ({ ...sheet, name: safeSheetName(sheet.name, taken) }));

  const entries = [
    {
      name: "[Content_Types].xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          named
            .map(
              (_, index) =>
                `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            )
            .join("") +
          `</Types>`
      )
    },
    {
      name: "_rels/.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`
      )
    },
    {
      name: "xl/workbook.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
          named
            .map(
              (sheet, index) =>
                `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
            )
            .join("") +
          `</sheets></workbook>`
      )
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          named
            .map(
              (_, index) =>
                `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
            )
            .join("") +
          `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`
      )
    },
    { name: "xl/styles.xml", data: utf8(STYLES_XML) },
    ...named.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: utf8(sheetXml(sheet))
    }))
  ];

  return zipStore(entries, now);
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function downloadXlsx(filename, sheets) {
  const blob = new Blob([buildXlsx(sheets)], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the download a moment to start before the blob goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
