# Tema da loja (ficheiros para copiar)

Peças do tema Shopify que dependem do integrador. Copiar para o tema (Loja online → Temas → Editar código).

| Ficheiro | Para quê |
|---|---|
| `sections/marcas.liquid` + `snippets/marca-item.liquid` | Secção "As nossas marcas" (homepage). Lê os metaobjects `marca`, mantidos pelo integrador em cada sync (`npm run brands:sync`). Logótipos de uma vez a partir de uma pasta: `npm run brands:logos -- <pasta> --apply` (ficheiro = nome da marca). Ordem e "esconder sempre" editam-se em Conteúdo → Metaobjects → Marca. |

Preço riscado (regra dos 30 dias): junto ao preço riscado, mostrar
`Preço mais baixo nos últimos 30 dias: {{ compare_at_price | money }}` quando `compare_at_price > price`.
