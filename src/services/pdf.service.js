/**
 * PDF pipeline.
 *
 * Two jobs:
 *   1. Store an uploaded PDF (source book scan or free ebook) under /uploads.
 *   2. Rasterise the first N pages (default 5) into WebP images that become
 *      the product gallery *when no images were uploaded manually*.
 *
 * Rendering strategy — first available wins:
 *   a) Poppler `pdftoppm` (fastest, best fidelity) — install `poppler-utils`.
 *   b) pdfjs-dist + @napi-rs/canvas, if those optional packages are present.
 * If neither is available the upload still succeeds; `pages: []` is returned
 * and the caller falls back to a placeholder cover.
 */
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const imageService = require('./image.service');
const { ROOT } = require('../middleware/upload');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);
const PREVIEW_PAGES = Number(process.env.PDF_PREVIEW_PAGES) || 5;
const PDFTOPPM = process.env.PDFTOPPM_PATH || 'pdftoppm';

/** Move a temp PDF into its permanent folder and return metadata. */
async function storePdf(tmpPath, { folder = 'pdf' } = {}) {
  const filename = path.basename(tmpPath);
  const dest = path.join(ROOT, folder, filename);
  await fs.rename(tmpPath, dest);
  const stat = await fs.stat(dest);

  let pageCount = null;
  try {
    // pdf-parse is pure JS and always available.
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(await fs.readFile(dest), { max: 1 });
    pageCount = parsed.numpages ?? null;
  } catch (err) {
    logger.debug('pdf-parse could not read page count:', err.message);
  }

  return {
    url: imageService.publicUrl(folder, filename),
    path: dest,
    filename,
    sizeBytes: stat.size,
    pageCount,
  };
}

async function popplerAvailable() {
  try {
    await execFileAsync(PDFTOPPM, ['-v']);
    return true;
  } catch (err) {
    // pdftoppm -v exits non-zero on some builds but still proves presence.
    return /pdftoppm/i.test(`${err.stderr || ''}${err.stdout || ''}`);
  }
}

/** (a) Poppler renderer. */
async function renderWithPoppler(pdfPath, pages) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sx-pdf-'));
  const prefix = path.join(tmpDir, 'page');

  await execFileAsync(PDFTOPPM, [
    '-png', '-r', '150', '-f', '1', '-l', String(pages), pdfPath, prefix,
  ], { maxBuffer: 1024 * 1024 * 64 });

  const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith('.png')).sort();
  const buffers = await Promise.all(files.slice(0, pages).map((f) => fs.readFile(path.join(tmpDir, f))));
  await fs.rm(tmpDir, { recursive: true, force: true });
  return buffers;
}

/** (b) pdf.js renderer — only used when the optional deps are installed. */
async function renderWithPdfJs(pdfPath, pages) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');

  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
  const count = Math.min(pages, doc.numPages);
  const buffers = [];

  for (let i = 1; i <= count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvasContext: ctx, viewport }).promise;
    buffers.push(canvas.toBuffer('image/png'));
  }
  return buffers;
}

/**
 * Rasterise the first `pages` pages of a PDF into stored WebP images.
 * @returns {Promise<Array>} image records ready to push into product.images
 */
async function extractPreviewImages(pdfPath, { pages = PREVIEW_PAGES, folder = 'products', altBase = '' } = {}) {
  let buffers = [];

  if (await popplerAvailable()) {
    try {
      buffers = await renderWithPoppler(pdfPath, pages);
    } catch (err) {
      logger.warn('pdftoppm failed:', err.message);
    }
  }

  if (!buffers.length) {
    try {
      buffers = await renderWithPdfJs(pdfPath, pages);
    } catch (err) {
      logger.warn('pdf.js fallback unavailable:', err.message);
    }
  }

  if (!buffers.length) {
    logger.warn('No PDF renderer available — install poppler-utils (pdftoppm) to auto-generate covers.');
    return [];
  }

  const base = path.basename(pdfPath, path.extname(pdfPath));
  return Promise.all(
    buffers.map((buf, i) =>
      imageService.storeBuffer(buf, {
        folder,
        filename: `${base}-p${i + 1}`,
        alt: altBase ? `${altBase} — page ${i + 1}` : `Page ${i + 1}`,
      }),
    ),
  );
}

/** Extract plain text (used for search indexing / description suggestions). */
async function extractText(pdfPath, maxPages = 10) {
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(await fs.readFile(pdfPath), { max: maxPages });
    return { text: parsed.text || '', pages: parsed.numpages, info: parsed.info || {} };
  } catch (err) {
    logger.warn('extractText failed:', err.message);
    return { text: '', pages: null, info: {} };
  }
}

module.exports = { storePdf, extractPreviewImages, extractText, PREVIEW_PAGES };
