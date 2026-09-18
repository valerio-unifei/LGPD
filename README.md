# Sanitizador LGPD (100% client-side)

Aplicação web estática que detecta e anonimiza dados pessoais (LGPD) em
documentos usando um modelo de rede neural transformadora (Legal-BERT,
quantizado em INT8, formato ONNX) para classificação de tokens (NER),
executado **inteiramente no navegador** via ONNX Runtime Web (WASM).

Nenhum arquivo, texto ou dado é enviado a qualquer servidor: toda a extração
de texto, tokenização, inferência do modelo e geração dos arquivos de saída
acontece localmente, no seu computador, dentro do navegador.

## Formatos de entrada suportados

- PDF (extração de texto via [pdf.js](https://mozilla.github.io/pdf.js/))
- DOCX (extração de texto via [mammoth.js](https://github.com/mwilliamson/mammoth.js))
- TXT / MD (leitura direta)
- Texto colado diretamente na caixa de texto

## Entidades detectadas

NOME, CPF, DATA, ENDERECO, CEP, TELEFONE, EMAIL e DINHEIRO (rótulos do
modelo `celiudos/legal-bert-lgpd`).

## Saídas geradas

1. **`<nome>_sanitizado.md`** — o texto original com as entidades sensíveis
   substituídas por marcadores no formato `[TIPO_N]` (ex.: `[CPF_1]`,
   `[NOME_2]`).
2. **`<nome>_dicionario.json`** — dicionário de decodificação que mapeia cada
   marcador ao valor original (`{"[CPF_1]": "123.456.789-00", ...}`),
   permitindo reverter a sanitização quando necessário/autorizado.

Para reverter, envie ou cole o documento sanitizado no tópico 1, abra
a opção **Reverter sanitização** e selecione o respectivo dicionário JSON. A
aplicação restaura os marcadores localmente e permite baixar o documento
original reconstruído.

## Como executar

Por causa das políticas de segurança dos navegadores (CORS/módulos ES para
`fetch` de arquivos locais), a página **não pode ser aberta diretamente**
com duplo clique (`file://`). É necessário servi-la por um servidor HTTP
local simples — isso **não** é processamento no servidor: o servidor apenas
entrega os arquivos estáticos, e todo o processamento (IA, extração de
texto, sanitização) continua acontecendo no navegador do usuário.

Exemplo com Python (já disponível no ambiente):

```powershell
python -m http.server 8000
```

Depois abra `http://localhost:8000/` no navegador.

Qualquer outro servidor estático (ex.: `npx serve`, extensão "Live Server"
do VS Code, IIS, nginx) funciona igualmente bem.

## Estrutura do projeto

```
web/
  index.html            Página principal (UI)
  css/style.css         Estilos
  js/
    tokenizer.js         Tokenizer WordPiece (BertTokenizer) em JS puro
    textExtract.js       Extração de texto de PDF/DOCX/TXT/MD
    ner.js                Carregamento do modelo ONNX + inferência + agregação de entidades
    app.js                Orquestração da UI e geração dos downloads
  model/                 Modelo ONNX (INT8) + tokenizer (vocab.txt, config.json)
  vendor/                 Bibliotecas de terceiros vendorizadas (onnxruntime-web, pdf.js, mammoth.js)
```

## Observações técnicas

- O modelo (`model/model.onnx`, ~330&nbsp;MB) é grande porque é uma variante
  *large* do BERT (24 camadas, hidden size 1024) quantizada em INT8. O
  primeiro carregamento pode demorar alguns segundos a minutos, dependendo
  do disco/rede; carregamentos seguintes se beneficiam do cache HTTP do
  navegador.
- Documentos longos são processados em janelas deslizantes de até 510
  subtokens (limite do modelo: 512, reservando `[CLS]`/`[SEP]`), com
  sobreposição de 128 subtokens para preservar contexto nas bordas —
  equivalente à estratégia `stride` usada no pipeline de referência em
  Python (`main.py`).
- A agregação de subtokens em entidades segue a estratégia `first` (rótulo
  da primeira subpalavra é atribuído à palavra inteira), reproduzindo o
  comportamento do pipeline `transformers` original.
