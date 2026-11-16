// Funções puras de normalização de valores de tags — sem dependências de DB.
// Importado por suprides/routes/tags.ts (SQLite).

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Termos técnicos preservados no sentence-case ──────────────────────────────

const PRESERVED_TERMS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bgoogle\s+tv\b/gi,    replacement: "Google TV"    },
  { pattern: /\bwi[-\s]?fi\b/gi,     replacement: "Wi-Fi"        },
  { pattern: /\bbluetooth\b/gi,      replacement: "Bluetooth"    },
  { pattern: /\bqled\b/gi,           replacement: "QLED"         },
  { pattern: /\bhdr10\b/gi,          replacement: "HDR10"        },
  { pattern: /\bmemc\b/gi,           replacement: "MEMC"         },
  { pattern: /\bpvr\b/gi,            replacement: "PVR"          },
  { pattern: /\bhbbtv\b/gi,          replacement: "HBBTV"        },
  { pattern: /\bdolby\s+vision\b/gi, replacement: "Dolby Vision" },
  { pattern: /\bdolby\s+atmos\b/gi,  replacement: "Dolby Atmos"  },
];

function applySeparatorCasing(s: string): string {
  return s.replace(/([;/,])(\s*)([a-zA-ZÀ-ÿ])/g, (_, sep, spaces, letter) =>
    sep === "," ? sep + spaces + letter.toLowerCase()
                : sep + spaces + letter.toUpperCase()
  );
}

function normalizeSentenceCase(value: string): string {
  let v = collapseSpaces(value).toLowerCase();
  v = v.charAt(0).toUpperCase() + v.slice(1);
  v = applySeparatorCasing(v);
  for (const { pattern, replacement } of PRESERVED_TERMS) {
    v = v.replace(pattern, replacement);
  }
  return v;
}

// ── Listas de cores ───────────────────────────────────────────────────────────

const PT_COLORS: Record<string, string> = {
  "preto":              "Preto",
  "preta":              "Preto",
  "branco":             "Branco",
  "branca":             "Branco",
  "cinzento":           "Cinzento",
  "cinza":              "Cinzento",
  "vermelho":           "Vermelho",
  "vermelha":           "Vermelho",
  "azul":               "Azul",
  "verde":              "Verde",
  "amarelo":            "Amarelo",
  "amarela":            "Amarelo",
  "laranja":            "Laranja",
  "rosa":               "Rosa",
  "roxo":               "Roxo",
  "roxa":               "Roxo",
  "violeta":            "Roxo",
  "castanho":           "Castanho",
  "marrom":             "Castanho",
  "dourado":            "Dourado",
  "dourada":            "Dourado",
  "ouro":               "Dourado",
  "prateado":           "Cinzento",
  "prata":              "Cinzento",
  "platina":            "Cinzento",
  "bege":               "Bege",
  "creme":              "Creme",
  "marfim":             "Creme",
  "bordeaux":           "Bordeaux",
  "bordo":              "Bordeaux",
  "turquesa":           "Turquesa",
  "lila":               "Lilás",
  "lilas":              "Lilás",
  "lavanda":            "Lilás",
  "magenta":            "Magenta",
  "ciano":              "Ciano",
  "azul-marinho":       "Azul-marinho",
  "azul marinho":       "Azul-marinho",
  "grafite":            "Grafite",
  "titanio":            "Titânio",
  "titanium":           "Titânio",
  "coral":              "Coral",
  "transparente":       "Transparente",
  "multicolor":         "Multicolor",
  "multi":              "Multicolor",
  "bronze":             "Bronze",
  "champagne":          "Bege",
  "aluminio":           "Cinzento",
  "inox":               "Cinzento",
  "niquel":             "Cinzento",
  // Cores Apple / marcas
  "meia-noite":         "Preto",
  "meia noite":         "Preto",
  "luz das estrelas":   "Branco",
  "estelar":            "Branco",
  "azeitona":           "Verde",
  "cipreste":           "Verde",
  "indigo":             "Azul",
  "raio de sol":        "Amarelo",
  "arenito":            "Bege",
  "barro":              "Castanho",
  "amora":              "Roxo",
  "cereja":             "Vermelho",
};

const EN_TO_PT: Record<string, string> = {
  "black":      "Preto",
  "white":      "Branco",
  "grey":       "Cinzento",
  "gray":       "Cinzento",
  "red":        "Vermelho",
  "blue":       "Azul",
  "green":      "Verde",
  "yellow":     "Amarelo",
  "orange":     "Laranja",
  "pink":       "Rosa",
  "purple":     "Roxo",
  "violet":     "Roxo",
  "brown":      "Castanho",
  "gold":       "Dourado",
  "golden":     "Dourado",
  "silver":     "Cinzento",
  "beige":      "Bege",
  "cream":      "Creme",
  "ivory":      "Creme",
  "navy":       "Azul-marinho",
  "turquoise":  "Turquesa",
  "teal":       "Turquesa",
  "lilac":      "Lilás",
  "lavender":   "Lilás",
  "magenta":    "Magenta",
  "cyan":       "Ciano",
  "coral":      "Coral",
  "mint":       "Verde",
  "charcoal":   "Cinzento",
  "burgundy":   "Bordeaux",
  "graphite":   "Grafite",
  "midnight":   "Preto",
  "starlight":  "Branco",
  "natural":    "Bege",
  "sand":       "Bege",
  "stone":      "Bege",
  "khaki":      "Bege",
  "olive":      "Verde",
  "rose":       "Rosa",
  "transparent":"Transparente",
  "clear":      "Transparente",
};

const ALL_COLOR_KEYS = new Set([
  ...Object.keys(PT_COLORS),
  ...Object.keys(EN_TO_PT),
]);

function lookupColor(word: string): string | null {
  const key = stripDiacritics(word);
  return PT_COLORS[key] ?? EN_TO_PT[key] ?? null;
}

// ── TAG: Tamanho (genérico) ───────────────────────────────────────────────────

function normalizeTamanho(value: string): string | null {
  let v = collapseSpaces(value.trim());
  if (/\d\s*[xX×]\s*\d/.test(v)) return null;
  const m3 = /^([\d.,]+)\s*[Mm]3$/.exec(v);
  if (m3) return `${m3[1]}m3`;
  v = v.replace(/([\d.,]+)\s*(pol|polegadas|inch)\b/gi, '$1"');
  v = v.replace(/([\d.,]+)\s*\bin\b/gi, '$1"');
  v = v.replace(/'{2}/g, '"');
  v = v.replace(/\s*\(\s*[\d.,]+\s*(cm|mm)\s*\)/gi, '').trim();
  const cmInches = /^[\d.,]+\s*cm\s*\/\s*(.+)$/i.exec(v);
  if (cmInches) v = cmInches[1].trim();
  v = v.replace(/([\d.,]+)\s+(cm|mm|")/g, "$1$2");
  if (/^[\d.,]+(cm|mm|"|m3)$/.test(v)) return v;
  return null;
}

// ── TAG: Tamanho do Ecrã ──────────────────────────────────────────────────────
// Ecrãs: valores em polegadas (usa ' ou " ou nada), mm (smartwatch), cm+polegadas
// Normaliza tudo para NN.N" ou NNmm

function normalizeTamanhoEcra(value: string): string | null {
  let v = collapseSpaces(value.trim());

  // "15,5 cm (6.1')" ou "16 cm (6.3')" → extrair parte entre parênteses
  const cmParen = /[\d.,]+\s*cm\s*\(\s*([\d.,]+)['"]\s*\)/.exec(v);
  if (cmParen) v = cmParen[1] + '"';

  // "17,5 cm (6.9')" com apóstrofo no final
  const cmParenApos = /[\d.,]+\s*cm\s*\(\s*([\d.,]+)\s*'\s*\)/.exec(v);
  if (cmParenApos) v = cmParenApos[1] + '"';

  // Normalizar apóstrofo simples ' → " como indicador de polegadas
  // mas só se não for já substituído e for no final
  v = v.replace(/^([\d.,]+)\s*'$/, '$1"');

  // "15,6'" → "15.6"" (vírgula decimal → ponto)
  v = v.replace(/^([\d]+),([\d]+)"$/, '$1.$2"');

  // "40 mm" / "42 mm" → "40mm"
  v = v.replace(/^([\d.,]+)\s*mm$/, '$1mm');

  // Remover espaço antes de "
  v = v.replace(/([\d.,]+)\s+"$/, '$1"');

  // Validar resultado: aceita NN" / NN.N" / NNmm / NN,Nmm
  if (/^[\d.,]+"$/.test(v) || /^[\d.,]+mm$/.test(v)) return v;

  // Compostos como "32"/55"" → deixar passar (já estão com ")
  if (/^[\d.,"\/]+$/.test(v) && v.includes('"')) return v;

  return null;
}

// ── TAG: Resolução / Qualidade ────────────────────────────────────────────────

const RESOLUCAO_MAP: Record<string, string> = {
  "4k uhd":                    "4K Ultra HD (3840x2160)",
  "ultra hd 4k":               "4K Ultra HD (3840x2160)",
  "3840 x 2160":               "4K Ultra HD (3840x2160)",
  "3840x2160":                 "4K Ultra HD (3840x2160)",
  "4k ultrahd (3840 x 2160)":  "4K Ultra HD (3840x2160)",
  "4k ultrahd (3840x2160)":    "4K Ultra HD (3840x2160)",
  "4k ultra hd (3840 x 2160)": "4K Ultra HD (3840x2160)",
  "4k ultra hd (3840x2160)":   "4K Ultra HD (3840x2160)",
  "full hd":                   "Full HD (1920x1080)",
  "1920 x 1080":               "Full HD (1920x1080)",
  "1920x1080":                 "Full HD (1920x1080)",
  "hd":                        "HD (1280x720)",
  "1280 x 720":                "HD (1280x720)",
  "1280x720":                  "HD (1280x720)",
  "2k":                        "2K (2560x1440)",
  "2560 x 1440":               "2K (2560x1440)",
  "2560x1440":                 "2K (2560x1440)",
  "8k":                        "8K (7680x4320)",
};

function normalizeResolucao(value: string): string | null {
  const v = collapseSpaces(value.trim());

  // Rejeitar padrões de outros grupos
  if (/[\d.,]\s*(gr?|gramas?)\b/i.test(v)) return null;
  if (/mAh|Wh\b/i.test(v)) return null;
  if (/GB|TB|MB/i.test(v)) return null;
  if (/\bHz\b/i.test(v)) return null;
  if (/cm\b|mm\b/i.test(v)) return null;

  const key = stripDiacritics(v);
  if (RESOLUCAO_MAP[key]) return RESOLUCAO_MAP[key];
  // "1920 x 1080 pixels" → "1920 x 1080"
  const pixelsStrip = v.replace(/\s*pixels?\s*$/i, "").trim();
  const keyStripped = stripDiacritics(pixelsStrip);
  if (RESOLUCAO_MAP[keyStripped]) return RESOLUCAO_MAP[keyStripped];
  // Normalizar "NxM" → "N x M" e devolver se for um par de números
  const normed = pixelsStrip.replace(/(\d)\s*[xX×]\s*(\d)/g, "$1 x $2");
  // Validar: deve ter padrão de resolução (NxM ou termo conhecido)
  if (/^\d+\s*x\s*\d+/.test(normed)) return normed;
  return null;
}

// ── TAG: Capacidade / Armazenamento ───────────────────────────────────────────

function normalizeCapacidade(value: string): string | null {
  let v = collapseSpaces(value.trim());

  // Rejeitar padrões de outros grupos
  if (/mAh|Wh\b/i.test(v)) return null;
  if (/GB|TB|MB|KB/i.test(v)) return null;               // armazenamento digital
  if (/Gbit|Gbps|Mbps/i.test(v)) return null;
  if (/\bcm\b|\bmm\b/i.test(v)) return null;

  v = v.replace(/([\d.,]+)\s*(LTS|LT|LITROS|litros?)\b/gi, (_, n) => `${n}L`);
  v = v.replace(/([\d.,]+)\s*[Kk][Gg]\b/g, (_, n) => `${n}Kg`);
  v = v.replace(/([\d.,]+)\s*[Mm][Ll]\b/g, (_, n) => `${n}ml`);

  // Validação final: apenas L, ml, Kg
  if (/^[\d.,]+L$/.test(v)) return v;
  if (/^[\d.,]+ml$/.test(v)) return v;
  if (/^[\d.,]+Kg$/.test(v)) return v;

  return null;
}

// ── TAG: Armazenamento (digital) ──────────────────────────────────────────────
// GB, TB, MB — sem espaço, B maiúsculo. "Gb" → "GB". 1000GB → 1TB.

function normalizeArmazenamento(value: string): string | null {
  let v = collapseSpaces(value.trim());

  // Rejeitar padrões de outros grupos
  if (/mAh/i.test(v)) return null;
  if (/Gbit\/s|Gbps|Mbps|GB\/s/i.test(v)) return null;          // velocidades de rede
  if (/metros?/i.test(v) || /^\d+[.,]?\d*\s*m$/i.test(v)) return null; // comprimentos
  if (/rolos?/i.test(v)) return null;
  if (/litros?|\bl\b|\bml\b/i.test(v)) return null;             // volumes
  if (/\bcm\b|\bmm\b/i.test(v)) return null;                    // dimensões físicas
  if (/\d+\s*g\b/i.test(v) && !/\d+G[Bb]/i.test(v)) return null; // gramas mas não GB
  if (/HDMI|VGA|DisplayPort|USB\s*[\d.]/i.test(v)) return null; // conectores
  if (/\bHz\b/i.test(v)) return null;                            // frequências
  if (/pixels?/i.test(v)) return null;                           // resolução
  if (/Cat\s*\d|OM\d/i.test(v)) return null;                    // cabos de rede
  if (/[xX×]\s*\d/.test(v)) return null;                        // dimensões NxM
  if (/4K|Ultra\s*HD|Full\s*HD/i.test(v)) return null;          // resoluções
  if (/50\/125/i.test(v)) return null;                           // fibra ótica
  if (/^\d+([.,]\d+)?$/.test(v)) return null;                   // número sem unidade

  // Normalizar case: GB, TB, MB, KB
  v = v.replace(/([\d.,]+)\s*[Gg][Bb]\b/,  (_, n) => `${n}GB`);
  v = v.replace(/([\d.,]+)\s*[Tt][Bb]\b/,  (_, n) => `${n}TB`);
  v = v.replace(/([\d.,]+)\s*[Mm][Bb]\b/,  (_, n) => `${n}MB`);
  v = v.replace(/([\d.,]+)\s*[Kk][Bb]\b/,  (_, n) => `${n}KB`);

  // Remover sufixo de tipo de memória: "512GB SSD", "256GB NVMe", "16GB EMMC"
  v = v.replace(/^([\d.,]+(GB|TB|MB|KB))\s+\w+$/i, '$1');

  // 1000GB → 1TB, 2000GB → 2TB
  const gbMatch = /^(\d+)GB$/.exec(v);
  if (gbMatch) {
    const gb = parseInt(gbMatch[1]);
    if (gb >= 1000 && gb % 1000 === 0) return `${gb / 1000}TB`;
  }

  // Validação final: apenas armazenamento digital com unidade
  if (/^[\d.,]+(GB|TB|MB|KB)$/.test(v)) return v;

  return null;
}

// ── TAG: RAM ──────────────────────────────────────────────────────────────────
// Normaliza para NGB / NMB / NKB sem espaço. Remove sufixo " RAM".

function normalizeRAM(value: string): string | null {
  let v = collapseSpaces(value.trim());

  // Rejeitar valores claramente errados
  if (/mAh/i.test(v)) return null;
  if (/^\d+\s*[Aa]$/.test(v)) return null;  // "6A", "3A" (amperagem)
  if (/Micro\s+AAA/i.test(v)) return null;

  // Remover sufixo " RAM" ou "+RAM"
  v = v.replace(/\s*\+?\s*RAM\s*$/i, "").trim();

  // "8G" → "8GB", "16G" → "16GB"
  v = v.replace(/^([\d.,]+)\s*G$/i, "$1GB");

  // "8.0GB" → "8GB"
  v = v.replace(/^(\d+)\.0\s*GB$/i, "$1GB");

  // Normalizar case e espaço: "8 GB" → "8GB", "8Gb" → "8GB"
  v = v.replace(/([\d.,]+)\s*[Gg][Bb]\b/, (_, n) => `${n}GB`);
  v = v.replace(/([\d.,]+)\s*[Mm][Bb]\b/, (_, n) => `${n}MB`);
  v = v.replace(/([\d.,]+)\s*[Kk][Bb]\b/, (_, n) => `${n}KB`);
  v = v.replace(/([\d.,]+)\s*[Kk][Bb]ytes\b/i, (_, n) => `${n}KB`);

  // "4+64 GB" → não normalizar (valor composto RAM+Storage)
  if (/\+/.test(v)) return null;

  // Validar: aceitar só formatos limpos
  if (/^[\d.,]+(GB|MB|KB|TB)$/.test(v)) return v;

  return null;
}

// ── TAG: Potência ─────────────────────────────────────────────────────────────

function normalizePotencia(value: string): string | null {
  const v = collapseSpaces(value.trim());
  if (/[Kk][Gg]/.test(v)) return null;
  if (/[*+]/.test(v)) return null;
  let r = v;
  r = r.replace(/\s*\/\s*$/, "");
  r = r.replace(/\s*\/\s*/g, "/");
  r = r.replace(/([\d.,]+)\s*(kW|KW|W)\b/g, "$1$2");
  // Rejeitar se não contiver W ou kW
  if (!/[Ww]/.test(r)) return null;
  return r;
}

// ── TAG: Conectividade ────────────────────────────────────────────────────────

function normalizeConectividade(value: string): string | null {
  const v = collapseSpaces(value.trim());
  if (/^[\d.,]+\s*[Ww]$/.test(v)) return null;
  let r = v;
  r = r.replace(/(\d+)\s*V\s+(\d+)\s*Hz/i, "$1V~$2Hz");
  r = r.replace(/\bwi[-\s]?fi\b/gi, "Wi-Fi");
  r = r.replace(/\bwifi\b/gi, "Wi-Fi");
  r = r.replace(/\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*[Gg]\b/g, "$1/$2G");
  return collapseSpaces(r);
}

// ── TAG: Cor / Variante ───────────────────────────────────────────────────────
// Converte inglês para PT-PT. Para valores não reconhecidos: sentence-case como fallback.

function normalizeCorVariante(value: string): string {
  const v = collapseSpaces(value.trim());

  // Correção de typos conhecidos antes de processar
  const typoFix: Record<string, string> = {
    "Cinzent0": "Cinzento",
    "Branca":   "Branco",
    "Preta":    "Preto",
    "Roxa":     "Roxo",
  };
  if (typoFix[v]) return typoFix[v];

  const segments = v.split(/\/|,|\+|\s+e\s+|\s+and\s+/i)
    .map(s => s.trim()).filter(Boolean);

  const found: string[] = [];

  for (const seg of segments) {
    const full = lookupColor(seg);
    if (full) {
      if (!found.includes(full)) found.push(full);
      continue;
    }
    // Tentar palavra a palavra
    let wordFound = false;
    for (const word of seg.split(/\s+/)) {
      const w = lookupColor(word);
      if (w && !found.includes(w)) { found.push(w); wordFound = true; }
    }
    // Se nenhuma palavra reconhecida, preservar o segmento original com sentence-case
    if (!wordFound) {
      const sc = normalizeSentenceCase(seg);
      if (!found.includes(sc)) found.push(sc);
    }
  }

  return found.join(" e ");
}

// ── TAG: Material ─────────────────────────────────────────────────────────────

function normalizeMaterial(value: string): string | null {
  const v = collapseSpaces(value.trim());
  if (ALL_COLOR_KEYS.has(stripDiacritics(v))) return null;
  return normalizeSentenceCase(v);
}

// ── TAG: Dimensões ────────────────────────────────────────────────────────────

function normalizeDimensoes(value: string): string | null {
  const v = collapseSpaces(value.trim());
  if (v.includes(";") || v.includes(":") || v.length > 80) return null;

  // Rejeitar padrões não-dimensionais
  if (/°/.test(v)) return null;                             // temperatura/ângulo
  if (/\bdpi\b/i.test(v)) return null;                      // resolução de impressão
  if (/mil\s+metros?/i.test(v)) return null;                // "mil metros"
  if (/\d+\s*e\s+\d+/i.test(v) && /dpi/i.test(v)) return null;
  if (/^\d+\s*g$/.test(v)) return null;                     // "106 g" (peso isolado)
  if (/gramas?/i.test(v)) return null;
  if (/\bkg\b/i.test(v)) return null;
  if (/\bHz\b/i.test(v)) return null;                       // frequência

  // Remover anotações de eixos entre parênteses: (LxAxP), (AxB)
  let r = v.replace(/\s*\([A-Za-z](?:[xX][A-Za-z]){1,2}\)\s*/g, "");
  // Remover anotações longas entre parênteses: "(LarguraxProfundidadexAltura)"
  r = r.replace(/\s*\([A-Za-zÀ-ÿ]{4,}[^)]*\)\s*/g, "");
  r = collapseSpaces(r.trim());

  // Normalizar separadores → x minúsculo
  r = r.replace(/\s*[xX×*]\s*/g, "x");

  // "80 mmx91 mmx33mm" → remover espaços antes de mm no meio das dimensões
  r = r.replace(/\s*(mm|cm)\s*x/g, "$1x");
  r = r.replace(/x\s*([\d])/g, "x$1");

  // Remover espaço antes da unidade final
  r = r.replace(/\s*(cm|mm)\s*$/i, (_, u) => u.toLowerCase());

  // Rejeitar se ficou com 'g' (gramas) no resultado
  if (/\d+\s*g\b/i.test(r) && !/\d+g\s*x\s*\d/.test(r)) return null;

  // Validação final: deve conter padrão de dimensão
  const isDimension =
    /\d+x\d+/.test(r) ||           // NxM ou NxMxP
    /\d+(mm|cm)/.test(r) ||        // N com unidade
    /\d+"/.test(r) ||               // N polegadas (")
    /^\d+[.,]\d+["']/.test(r) ||   // N.N polegadas
    /^\d+'\s*$/.test(r);            // N pés/polegadas (')

  if (!isDimension) return null;

  return r;
}

// ── TAG: Marca / Fabricante ───────────────────────────────────────────────────

function normalizeMarca(value: string): string {
  return collapseSpaces(value).toUpperCase();
}

// ── TAG: Autonomia ────────────────────────────────────────────────────────────
// "8000 mAh" → "8000mAh", "30 h" → "30h", "6 horas" → "6h", "7 dias" → "7 dias"

function normalizeAutonomia(value: string): string | null {
  let v = collapseSpaces(value.trim());

  // Strip prefixo duplicado do AI: "Autonomia: 10h" → "10h"
  v = v.replace(/^[Aa]utonomia:\s*/i, "").trim();

  // Rejeitar strings vazias ou placeholder
  if (!v || /^""$/.test(v)) return null;
  // Rejeitar descrições longas (tempo de carregamento, reprodução, etc.)
  if (v.length > 60) return null;
  if (/carregamento|reprodu/i.test(v)) return null;

  // Rejeitar faixas de comprimento físico: "130 - 190 mm"
  if (/\d\s*[-–]\s*\d.*mm/i.test(v)) return null;

  // Rejeitar padrões de outros grupos
  if (/Gbit|Gbps|Mbps/i.test(v)) return null;              // velocidades de rede
  if (/\bHz\b/i.test(v)) return null;                       // frequências
  if (/^\d+([.,]\d+)?\s*V$|^\d+\/\d+\s*V/i.test(v)) return null; // voltagem
  if (/IPX?\d/i.test(v)) return null;                       // certificação IP
  if (/^CR\d+/i.test(v)) return null;                       // tipo de pilha
  if (/^\d+\/\d+$/.test(v)) return null;                    // rácios 16/7, 24/7
  if (/n[íi]veis?/i.test(v)) return null;                  // níveis de pressão
  if (/gramas?/i.test(v) || /^\d+\s*g$/i.test(v)) return null; // peso
  if (/Tage/i.test(v)) return null;                         // texto em alemão
  if (/^\d+$/.test(v)) return null;                         // número sem unidade

  // Normalizar separador de milhar em mAh: "5.000mAh" / "30 000mAh" → sem separador
  v = v.replace(/(\d)\.(\d{3})\s*mAh/i, "$1$2mAh");
  v = v.replace(/(\d) (\d{3})\s*mAh/i,  "$1$2mAh");

  // Valores compostos: "10000mAh/37Wh" → manter só o primeiro
  v = v.replace(/^([\d.,]+mAh)\/.*/i, "$1");

  // mAh
  v = v.replace(/([\d.,]+)\s*mAh\b/i, (_, n) => `${n}mAh`);
  // Wh
  v = v.replace(/([\d.,]+)\s*Wh\b/i,  (_, n) => `${n}Wh`);
  // horas → h
  v = v.replace(/([\d.,]+)\s*horas?\b/i, (_, n) => `${n}h`);
  // "30 h" → "30h"
  v = v.replace(/([\d.,]+)\s+h\b/, (_, n) => `${n}h`);
  // dias e variantes
  v = v.replace(/\b(\d+)\s+[Dd]ias?\b/, (_, n) => `${n} dias`);
  v = v.replace(/^(\d+)\s*d$/i, "$1 dias");               // "146d", "85 d"
  // meses e variantes
  v = v.replace(/\b(\d+)\s+m[eê]s\s*\(m[eê]ses?\)\b/i, (_, n) => `${n} meses`);
  v = v.replace(/\b(\d+)\s+m[eê]s(?:es)?\b/i,            (_, n) => `${n} meses`);
  v = v.replace(/^1\s+[Mm][eê]s?$/i, "1 mês");
  // km
  v = v.replace(/([\d.,]+)\s*[Kk]ms?\b/, (_, n) => `${n}km`);
  // Normalizar "até"/"Até"
  v = v.replace(/^[Aa]t[eé]\s+/, "Até ");

  // Validação final: só aceitar formatos de duração/distância reconhecidos
  const VALID_PATTERNS = [
    /^[\d.,]+mAh$/,
    /^[\d.,]+Wh$/,
    /^[\d.,]+h$/,
    /^\d+\s*dias?$/i,
    /^\d+\s*meses?$/i,
    /^\d+\s*m[eê]s$/i,
    /^\d+\s*km$/i,
    /^[Aa]té\s+[\d.,]+h$/,
    /^[Aa]té\s+[\d.,]+h\)?$/,
    /^[Aa]té\s+\d+\s*dias?$/i,
    /^[Aa]té\s+\d+\s*meses?$/i,
    /^[Aa]té\s+\d+\s*km$/i,
    /^\d+\s*[-–]\s*\d+\s*[hH]$/,       // "5-7h"
    /^\d+\s*[aA]\s*\d+[hH]$/,           // "2 a 3h"
    /^\d+\s*[-–]\s*\d+\s*dias?$/i,      // "5-7 dias"
    /^\d+\s*[-–]\s*\d+\s*km$/i,
    /^\d+h\s*\(.*\)$/,                   // "100h (ANC OFF)"
    /^\d+\s*[-–]\s*\d+\s*dias?$/i,
  ];

  if (!VALID_PATTERNS.some(p => p.test(v))) return null;
  return v;
}

// ── TAG: Classe Energética ────────────────────────────────────────────────────
// Aceita: A, B, C, D, E, F, G, "A a G", "80 PLUS Gold/Bronze/Silver"

function normalizeClasseEnergetica(value: string): string | null {
  const v = collapseSpaces(value.trim()).toUpperCase();

  // Rejeitar valores de potência (W)
  if (/^\d+\s*W$/.test(v)) return null;

  // "80 PLUS GOLD/BRONZE/SILVER/PLATINUM" → normalizar espaços
  if (/^80\s*PLUS/.test(v)) {
    return v.replace(/\s+/g, " ").replace(/80\s*PLUS/, "80 PLUS");
  }

  // Letras simples ou ranges: A, B, ..., "A A G"
  if (/^[A-G](\s+A\s+[A-G])?$/.test(v)) {
    return v.replace(/\s+A\s+/, " a ");
  }

  // Rejeitar qualquer outro valor não reconhecido
  return null;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export const SENTENCE_CASE_TAGS = new Set([
  "tipo de produto / formato",
  "tipo de produto",
  "uso / finalidade",
  "funcoes",
  "categoria / subcategoria",
  "categoria",
  "compatibilidade / sistema",
  "formato",
]);

export function applyRule(tagNome: string, value: string): string | null {
  const key  = stripDiacritics(tagNome);
  const base = collapseSpaces(value.trim());
  if (!base) return null;

  // Tamanho do Ecrã — chave específica primeiro, depois genérica
  if (key === "tamanho do ecra" || key === "tamanho do ecran")
                                                                 return normalizeTamanhoEcra(base);
  if (key === "tamanho")                                         return normalizeTamanho(base);

  if (key === "resolucao / qualidade" || key === "resolucao")    return normalizeResolucao(base);

  // Armazenamento digital (GB/TB) vs capacidade (litros/Kg)
  if (key === "armazenamento")                                   return normalizeArmazenamento(base);
  if (key === "capacidade / armazenamento" || key === "capacidade")
                                                                 return normalizeCapacidade(base);

  if (key === "ram" || key === "memoria ram" || key === "memoria")
                                                                 return normalizeRAM(base);
  if (key === "potencia")                                        return normalizePotencia(base);
  if (key === "conectividade")                                   return normalizeConectividade(base);
  if (key === "cor / variante" || key === "cor")                 return normalizeCorVariante(base);
  if (key === "material")                                        return normalizeMaterial(base);
  if (key === "dimensoes")                                       return normalizeDimensoes(base);
  if (key === "marca / fabricante" ||
      key === "marca" || key === "fabricante")                   return normalizeMarca(base);
  if (key === "autonomia")                                       return normalizeAutonomia(base);
  if (key === "classe energetica")                               return normalizeClasseEnergetica(base);

  if (SENTENCE_CASE_TAGS.has(key))                               return normalizeSentenceCase(base);

  return base;
}
