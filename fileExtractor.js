const path = require('path');
const readXlsxFile = require('read-excel-file/node').default || require('read-excel-file/node');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

const MAX_EXTRACTED_CHARS = 120_000;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function clipText(text) {
  const cleaned = String(text || '').replace(/\u0000/g, '').trim();
  if (!cleaned) return '';
  return cleaned.length > MAX_EXTRACTED_CHARS
    ? `${cleaned.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Text truncated because the file is large.]`
    : cleaned;
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return clipText(result.text || (result.pages || []).map((page) => page.text || '').join('\n'));
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return clipText(result.value);
}

async function extractSpreadsheet(buffer) {
  const sheets = await readXlsxFile(buffer);
  const parts = [];

  for (const sheetObj of sheets) {
    const sheetName = sheetObj.sheet || 'Sheet';
    const rows = (sheetObj.data || []).map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join(',')
    );
    parts.push(`SHEET: ${sheetName}\n${rows.join('\n')}`);
  }

  return clipText(parts.join('\n\n'));
}

async function extractFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  let text;

  switch (extension) {
    case '.pdf':
      text = await extractPdf(file.buffer);
      break;
    case '.docx':
      text = await extractDocx(file.buffer);
      break;
    case '.xlsx':
      text = await extractSpreadsheet(file.buffer);
      break;
    case '.txt':
    case '.csv':
      text = clipText(file.buffer.toString('utf8'));
      break;
    default:
      throw badRequest('Unsupported file type. Upload PDF, DOCX, TXT, CSV or XLSX.');
  }

  if (!text) {
    throw badRequest('No readable text was found. The file may be scanned, empty or password-protected.');
  }

  return text;
}

module.exports = { extractFile };
