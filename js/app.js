/**
 * Orquestração da interface: extração de texto, execução do NER,
 * sanitização e geração dos downloads (MD sanitizado + JSON de decodificação).
 * Tudo roda 100% no navegador do usuário.
 */

import { extractText } from "./textExtract.js";
import { LgpdSanitizer, sanitizeTextWithEntities } from "./ner.js";

const els = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  pasteText: document.getElementById("pasteText"),
  fileName: document.getElementById("fileName"),
  btnSanitize: document.getElementById("btnSanitize"),
  btnClear: document.getElementById("btnClear"),
  statusBox: document.getElementById("statusBox"),
  progressBar: document.getElementById("progressBar"),
  progressFill: document.getElementById("progressFill"),
  resultSection: document.getElementById("resultSection"),
  entitySummary: document.getElementById("entitySummary"),
  previewSanitized: document.getElementById("previewSanitized"),
  btnDownloadMd: document.getElementById("btnDownloadMd"),
  btnDownloadJson: document.getElementById("btnDownloadJson"),
  modelLoadNotice: document.getElementById("modelLoadNotice"),
};

let selectedFile = null;
let sanitizer = null;
let lastResult = null; // { sanitizedText, dictionary, entities, baseName }

function setStatus(message, isError = false) {
  els.statusBox.textContent = message;
  els.statusBox.classList.toggle("error", isError);
  els.statusBox.hidden = !message;
}

function setProgress(fraction) {
  const pct = Math.max(0, Math.min(1, fraction));
  els.progressBar.hidden = false;
  els.progressFill.style.width = `${(pct * 100).toFixed(1)}%`;
  if (pct >= 1) {
    setTimeout(() => {
      els.progressBar.hidden = true;
      els.progressFill.style.width = "0%";
    }, 400);
  }
}

function resetOutputs() {
  els.resultSection.hidden = true;
  els.entitySummary.innerHTML = "";
  els.previewSanitized.textContent = "";
  lastResult = null;
}

async function getSanitizer() {
  if (sanitizer) return sanitizer;
  sanitizer = new LgpdSanitizer();
  els.modelLoadNotice.hidden = false;
  await sanitizer.load((frac, msg) => {
    setProgress(frac);
    setStatus(msg || "Carregando modelo...");
  });
  els.modelLoadNotice.hidden = true;
  return sanitizer;
}

function baseNameFromFile(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function summarizeEntities(entities) {
  const counts = {};
  for (const ent of entities) counts[ent.type] = (counts[ent.type] || 0) + 1;
  els.entitySummary.innerHTML = "";
  const typesFound = Object.keys(counts).sort();
  if (typesFound.length === 0) {
    const span = document.createElement("span");
    span.className = "badge badge-empty";
    span.textContent = "Nenhuma entidade sensível detectada";
    els.entitySummary.appendChild(span);
    return;
  }
  for (const type of typesFound) {
    const span = document.createElement("span");
    span.className = "badge";
    span.textContent = `${type}: ${counts[type]}`;
    els.entitySummary.appendChild(span);
  }
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function runSanitization() {
  try {
    els.btnSanitize.disabled = true;
    resetOutputs();

    let rawText = "";
    let baseName = "documento";

    if (selectedFile) {
      setStatus(`Extraindo texto de "${selectedFile.name}"...`);
      rawText = await extractText(selectedFile);
      baseName = baseNameFromFile(selectedFile.name);
    } else if (els.pasteText.value.trim()) {
      rawText = els.pasteText.value;
      baseName = "texto_colado";
    } else {
      setStatus("Selecione um arquivo ou cole um texto antes de sanitizar.", true);
      return;
    }

    if (!rawText.trim()) {
      setStatus("Não foi possível extrair texto do documento fornecido.", true);
      return;
    }

    setStatus("Carregando modelo de reconhecimento de entidades (primeira vez pode demorar)...");
    const engine = await getSanitizer();

    setStatus("Analisando o texto em busca de dados pessoais (LGPD)...");
    setProgress(0);
    const entities = await engine.recognizeEntities(rawText, (frac) => {
      setProgress(frac);
      setStatus(`Analisando o texto... (${(frac * 100).toFixed(0)}%)`);
    });

    const { sanitizedText, dictionary, entities: placedEntities } = sanitizeTextWithEntities(
      rawText,
      entities
    );

    lastResult = { sanitizedText, dictionary, entities: placedEntities, baseName };

    els.previewSanitized.textContent = sanitizedText;
    summarizeEntities(placedEntities);
    els.resultSection.hidden = false;
    setStatus(
      `Concluído: ${placedEntities.length} entidade(s) sanitizada(s). Faça o download dos arquivos abaixo.`
    );
  } catch (err) {
    console.error(err);
    setStatus(`Erro: ${err.message || err}`, true);
  } finally {
    els.btnSanitize.disabled = false;
  }
}

function handleFileSelected(file) {
  selectedFile = file;
  els.fileName.textContent = file ? file.name : "";
  if (file) els.pasteText.value = "";
}

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropZone.classList.add("dragover");
});
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragover"));
els.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  if (file) handleFileSelected(file);
});
els.pasteText.addEventListener("input", () => {
  if (els.pasteText.value.trim()) {
    selectedFile = null;
    els.fileInput.value = "";
    els.fileName.textContent = "";
  }
});

els.btnSanitize.addEventListener("click", runSanitization);

els.btnClear.addEventListener("click", () => {
  selectedFile = null;
  els.fileInput.value = "";
  els.fileName.textContent = "";
  els.pasteText.value = "";
  resetOutputs();
  setStatus("");
});

els.btnDownloadMd.addEventListener("click", () => {
  if (!lastResult) return;
  const header = `<!-- Documento sanitizado conforme a LGPD em ${new Date().toLocaleString(
    "pt-BR"
  )} -->\n\n`;
  downloadBlob(header + lastResult.sanitizedText, `${lastResult.baseName}_sanitizado.md`, "text/markdown");
});

els.btnDownloadJson.addEventListener("click", () => {
  if (!lastResult) return;
  const payload = {
    gerado_em: new Date().toISOString(),
    arquivo_origem: lastResult.baseName,
    total_entidades: lastResult.entities.length,
    dicionario: lastResult.dictionary,
  };
  downloadBlob(
    JSON.stringify(payload, null, 2),
    `${lastResult.baseName}_dicionario.json`,
    "application/json"
  );
});
