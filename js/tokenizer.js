/**
 * Tokenizer WordPiece (estilo BertTokenizer) implementado em puro JavaScript,
 * client-side, sem dependências externas. Reproduz o comportamento do
 * tokenizer HuggingFace usado para treinar o modelo (do_lower_case=false,
 * strip_accents=false, tokenize_chinese_chars=true), mantendo o mapeamento
 * de deslocamento (offsets) de cada subtoken para o texto original — algo
 * essencial para reconstruir os spans das entidades detectadas.
 */

const MAX_INPUT_CHARS_PER_WORD = 100;

function isWhitespace(ch) {
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  return /\p{Zs}/u.test(ch);
}

function isControl(ch) {
  if (ch === "\t" || ch === "\n" || ch === "\r") return false;
  return /\p{C}/u.test(ch);
}

function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

function isCJKChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/**
 * Tokenização básica preservando os offsets de caractere no texto original.
 * Retorna uma lista de "palavras" { text, start, end }.
 */
function basicTokenizeWithOffsets(text) {
  const words = [];
  let bufStart = -1;

  const flush = (end) => {
    if (bufStart !== -1) {
      words.push({ text: text.slice(bufStart, end), start: bufStart, end });
      bufStart = -1;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cp = text.codePointAt(i);

    if (isControl(ch)) {
      flush(i);
      continue;
    }
    if (isWhitespace(ch)) {
      flush(i);
      continue;
    }
    if (isPunctuation(ch) || isCJKChar(cp)) {
      flush(i);
      words.push({ text: ch, start: i, end: i + 1 });
      continue;
    }
    if (bufStart === -1) bufStart = i;
  }
  flush(text.length);
  return words;
}

export class WordPieceTokenizer {
  /**
   * @param {Map<string, number>} vocab token -> id
   * @param {object} specialTokens { cls, sep, pad, unk }
   */
  constructor(vocab, specialTokens) {
    this.vocab = vocab;
    this.cls = specialTokens.cls;
    this.sep = specialTokens.sep;
    this.pad = specialTokens.pad;
    this.unk = specialTokens.unk;
    this.clsId = vocab.get(this.cls);
    this.sepId = vocab.get(this.sep);
    this.padId = vocab.get(this.pad);
    this.unkId = vocab.get(this.unk);
  }

  static async fromVocabUrl(vocabUrl, specialTokens) {
    const res = await fetch(vocabUrl);
    if (!res.ok) throw new Error(`Falha ao carregar vocab.txt (${res.status})`);
    const raw = await res.text();
    const lines = raw.split(/\r?\n/);
    const vocab = new Map();
    for (let i = 0; i < lines.length; i++) {
      const tok = lines[i];
      if (tok.length === 0 && i === lines.length - 1) continue; // linha em branco final
      vocab.set(tok, i);
    }
    return new WordPieceTokenizer(vocab, specialTokens);
  }

  /** Faz o wordpiece de uma única palavra (substring), retornando peças com offsets relativos à palavra. */
  _wordpieceWord(word) {
    if (word.length > MAX_INPUT_CHARS_PER_WORD) {
      return [{ token: this.unk, id: this.unkId, start: 0, end: word.length, isUnk: true }];
    }
    const output = [];
    let start = 0;
    let isBad = false;
    while (start < word.length) {
      let end = word.length;
      let curSubstr = null;
      let curId = null;
      while (start < end) {
        let substr = word.slice(start, end);
        if (start > 0) substr = "##" + substr;
        if (this.vocab.has(substr)) {
          curSubstr = substr;
          curId = this.vocab.get(substr);
          break;
        }
        end -= 1;
      }
      if (curSubstr === null) {
        isBad = true;
        break;
      }
      output.push({ token: curSubstr, id: curId, start, end });
      start = end;
    }
    if (isBad) {
      return [{ token: this.unk, id: this.unkId, start: 0, end: word.length, isUnk: true }];
    }
    return output;
  }

  /**
   * Tokeniza o texto completo do documento.
   * Retorna { words, pieces } onde:
   *  - words: [{ text, start, end }] (uma entrada por "palavra" básica)
   *  - pieces: [{ id, token, wordIndex, start, end }] (subtokens WordPiece, offsets absolutos no texto)
   */
  tokenizeDocument(text) {
    const words = basicTokenizeWithOffsets(text);
    const pieces = [];
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      const sub = this._wordpieceWord(word.text);
      for (const piece of sub) {
        pieces.push({
          id: piece.id,
          token: piece.token,
          wordIndex: w,
          start: word.start + piece.start,
          end: word.start + piece.end,
        });
      }
    }
    return { words, pieces };
  }
}
