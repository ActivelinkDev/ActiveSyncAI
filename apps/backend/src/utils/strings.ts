// Pequenos utilitários para normalizar textos vindos de HTML/JSON

/** Decodifica entidades HTML (&aacute;, &#241;, &#xE7;, etc.), remove tags e normaliza espaços */
export function decodeHtmlish(input: any): string {
  let s = String(input ?? "");
  if (!s) return "";

  // numéricas dec / hex
  s = s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // algumas entidades comuns em PT
  const map: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
    agrave: "à", atilde: "ã", otilde: "õ", acirc: "â", ecirc: "ê", ocirc: "ô",
    Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
    Agrave: "À", Atilde: "Ã", Otilde: "Õ", ccedil: "ç", Ccedil: "Ç", ordm: "º",
  };
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => map[name] ?? m);

  // quebra de linha e limpeza de tags
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  // normalizar espaços
  s = s
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}

/** Remove acentos e NBSP, útil para chaves/joins */
export function normalizeDiacritics(s: any): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}
