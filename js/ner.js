/* global ort */

import { WordPieceTokenizer } from "./tokenizer.js";

const MODEL_DIR = "../model/";
const MODEL_CHUNKS_DIR = "../onnx_chunks/";
const MAX_SEQ_LEN = 512;
const MAX_CONTENT_TOKENS = MAX_SEQ_LEN - 2; // reserva [CLS] e [SEP]
const STRIDE = 128; // sobreposição entre janelas, em subtokens

const SPECIAL_TOKENS = { cls: "[CLS]", sep: "[SEP]", pad: "[PAD]", unk: "[UNK]" };

export class LgpdSanitizer {
  constructor() {
    this.session = null;
    this.tokenizer = null;
    this.id2label = null;
  }

  /**
   * Carrega tokenizer + modelo ONNX multipartes (.bin).
   */
  async load(onProgress = () => {}) {
    onProgress(0, "Carregando configuração do modelo...");
    const config = await fetch(new URL(MODEL_DIR + "config.json", import.meta.url)).then((r) =>
      r.json()
    );
    this.id2label = config.id2label;

    onProgress(0.02, "Carregando vocabulário (tokenizer)...");
    this.tokenizer = await WordPieceTokenizer.fromVocabUrl(
      new URL(MODEL_DIR + "vocab.txt", import.meta.url),
      SPECIAL_TOKENS
    );

    ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).toString();
    ort.env.wasm.numThreads = 1; // evita exigir cross-origin isolation (SharedArrayBuffer)
    ort.env.wasm.simd = true;

    // Baixa o modelo dividido através do manifesto JSON
    const modelBytes = await this._fetchChunkedModelWithProgress(
      new URL(MODEL_CHUNKS_DIR + "manifest.json", import.meta.url).toString(),
      (frac) => onProgress(0.02 + frac * 0.88, "Baixando partes do modelo ONNX...")
    );

    onProgress(0.92, "Inicializando sessão ONNX Runtime (isso pode levar alguns segundos)...");
    this.session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    onProgress(1, "Modelo carregado.");
  }

  /**
   * Baixa o manifesto e busca sequencialmente/paralelamente os chunks .bin
   * informando a porcentagem exata de progresso contínuo.
   */
  async _fetchChunkedModelWithProgress(manifestUrl, onProgress) {
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) throw new Error(`Falha ao carregar manifesto (${manifestRes.status})`);
    
    const manifest = await manifestRes.json();
    const chunkFiles = manifest.chunkFiles;
    const totalChunks = chunkFiles.length;

    const downloadedBuffers = new Array(totalChunks);
    let completedChunks = 0;

    // Baixa os chunks e reporta o progresso com base na contagem de arquivos
    for (let i = 0; i < totalChunks; i++) {
      const chunkUrl = new URL(MODEL_CHUNKS_DIR + chunkFiles[i], import.meta.url).toString();
      const res = await fetch(chunkUrl);
      if (!res.ok) throw new Error(`Falha ao baixar bloco ${chunkFiles[i]} (${res.status})`);
      
      downloadedBuffers[i] = await res.arrayBuffer();
      completedChunks++;
      
      // Notifica o progresso proporcional ao número de partes concluídas
      onProgress(completedChunks / totalChunks);
    }

    // Calcula o tamanho total necessário do array unificado
    const totalLength = downloadedBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const fullModelArray = new Uint8Array(totalLength);

    // Concatena todos os ArrayBuffers em um único Uint8Array
    let offset = 0;
    for (const buffer of downloadedBuffers) {
      fullModelArray.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

    return fullModelArray;
  }

  /**
   * Executa NER sobre o texto completo, tratando documentos longos por meio
   * de janelas deslizantes (sliding window) com sobreposição.
   */
  async recognizeEntities(text, onProgress = () => {}) {
    if (!this.session) throw new Error("Modelo ainda não carregado.");
    if (!text || !text.trim()) return [];

    const { words, pieces } = this.tokenizer.tokenizeDocument(text);
    if (pieces.length === 0) return [];

    const pieceLabelIds = new Array(pieces.length).fill(-1);

    const step = MAX_CONTENT_TOKENS - STRIDE;
    const windowStarts = [];
    for (let start = 0; start < pieces.length; start += step) {
      windowStarts.push(start);
      if (start + MAX_CONTENT_TOKENS >= pieces.length) break;
    }

    for (let w = 0; w < windowStarts.length; w++) {
      const start = windowStarts[w];
      const end = Math.min(start + MAX_CONTENT_TOKENS, pieces.length);
      const isLastWindow = w === windowStarts.length - 1;
      const windowLen = end - start;

      const inputIds = new BigInt64Array(windowLen + 2);
      inputIds[0] = BigInt(this.tokenizer.clsId);
      for (let i = 0; i < windowLen; i++) inputIds[i + 1] = BigInt(pieces[start + i].id);
      inputIds[windowLen + 1] = BigInt(this.tokenizer.sepId);

      const attentionMask = new BigInt64Array(windowLen + 2).fill(1n);

      const feeds = {
        input_ids: new ort.Tensor("int64", inputIds, [1, windowLen + 2]),
        attention_mask: new ort.Tensor("int64", attentionMask, [1, windowLen + 2]),
      };

      const results = await this.session.run(feeds);
      const logits = results.logits;
      const numLabels = logits.dims[2];
      const data = logits.data;

      for (let i = 0; i < windowLen; i++) {
        const globalIdx = start + i;
        const isTail = !isLastWindow && i >= windowLen - Math.floor(STRIDE / 2);
        if (isTail) continue;

        const base = (i + 1) * numLabels;
        let bestId = 0;
        let bestVal = -Infinity;
        for (let c = 0; c < numLabels; c++) {
          const v = data[base + c];
          if (v > bestVal) {
            bestVal = v;
            bestId = c;
          }
        }
        pieceLabelIds[globalIdx] = bestId;
      }

      onProgress((w + 1) / windowStarts.length);
    }

    return this._buildEntitiesFromPieces(text, words, pieces, pieceLabelIds);
  }

  _buildEntitiesFromPieces(text, words, pieces, pieceLabelIds) {
    const wordLabel = new Array(words.length).fill(null);
    for (let p = 0; p < pieces.length; p++) {
      const wi = pieces[p].wordIndex;
      if (wordLabel[wi] === null) {
        const labelId = pieceLabelIds[p];
        wordLabel[wi] = labelId >= 0 ? this.id2label[String(labelId)] : "O";
      }
    }

    const entities = [];
    let current = null;

    const closeCurrent = () => {
      if (current) {
        const startChar = words[current.startWord].start;
        const endChar = words[current.endWord].end;
        entities.push({
          type: current.type,
          start: startChar,
          end: endChar,
          text: text.slice(startChar, endChar),
        });
        current = null;
      }
    };

    for (let wi = 0; wi < words.length; wi++) {
      const label = wordLabel[wi] || "O";
      if (label === "O") {
        closeCurrent();
        continue;
      }
      const prefix = label.slice(0, 1);
      const type = label.slice(2);

      if (prefix === "B" || !current || current.type !== type) {
        closeCurrent();
        current = { type, startWord: wi, endWord: wi };
      } else {
        current.endWord = wi;
      }
    }
    closeCurrent();

    return entities;
  }
}

export function sanitizeTextWithEntities(text, entities) {
  const sorted = [...entities].sort((a, b) => a.start - b.start);

  const counters = {};
  const withPlaceholders = sorted.map((ent) => {
    counters[ent.type] = (counters[ent.type] || 0) + 1;
    return { ...ent, placeholder: `[${ent.type}_${counters[ent.type]}]` };
  });

  const dictionary = {};
  for (const ent of withPlaceholders) {
    dictionary[ent.placeholder] = ent.text;
  }

  let sanitized = text;
  for (let i = withPlaceholders.length - 1; i >= 0; i--) {
    const ent = withPlaceholders[i];
    sanitized = sanitized.slice(0, ent.start) + ent.placeholder + sanitized.slice(ent.end);
  }

  return { sanitizedText: sanitized, dictionary, entities: withPlaceholders };
}