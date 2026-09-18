/**
 * Extração de texto client-side a partir de PDF, DOCX, TXT ou MD.
 * Nenhum arquivo é enviado para qualquer servidor: tudo é processado
 * localmente no navegador usando pdf.js e mammoth.js (vendorizados).
 */

/* global mammoth */

let pdfjsLibPromise = null;

function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(new URL("../vendor/pdfjs/pdf.min.mjs", import.meta.url)).then(
      (mod) => {
        mod.GlobalWorkerOptions.workerSrc = new URL(
          "../vendor/pdfjs/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
        return mod;
      }
    );
  }
  return pdfjsLibPromise;
}

async function extractFromPdf(arrayBuffer) {
  const pdfjsLib = await getPdfjsLib();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    let lastY = null;
    let line = "";
    const lines = [];
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 1) {
        lines.push(line);
        line = "";
      }
      line += item.str;
      lastY = item.transform[5];
    }
    if (line) lines.push(line);
    pageTexts.push(lines.join("\n"));
  }
  return pageTexts.join("\n\n");
}

async function extractFromDocx(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractFromPlainText(file) {
  return file.text();
}

/**
 * @param {File} file
 * @returns {Promise<string>} texto extraído em UTF-8
 */
export async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    return extractFromPdf(buf);
  }
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    return extractFromDocx(buf);
  }
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return extractFromPlainText(file);
  }
  throw new Error(
    `Tipo de arquivo não suportado: ${file.name}. Use PDF, DOCX, TXT ou MD.`
  );
}
