const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();

wb.xlsx.readFile('tags_shopify_megadigital.xlsx').then(() => {
  const ws = wb.worksheets.find(w => w.name.includes('tag_definitions'));
  if (!ws) {
    console.error('Folha tag_definitions não encontrada!');
    return;
  }
  const filtros = new Set();
  ws.eachRow((row, i) => {
    if (i < 3) return;
    const v = row.values;
    if (v[2]) filtros.add(v[2]);
  });
  console.log('Filtros disponíveis para dropdown:', Array.from(filtros));
});