const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache em memória
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ============================================================
// 🔧 CONFIGURAÇÃO DA PLANILHA — EDITE AQUI SE NECESSÁRIO
// ============================================================
//
// O SHEET_ID vem da URL da sua planilha:
// https://docs.google.com/spreadsheets/d/[ SHEET_ID ]/edit
//
const SHEET_ID = '1thhOQxlobQZxKmt6aMFcqa-0CJB3_swU'; // ← ID da sua planilha (já correto!)

// GIDs de cada aba (cada aba tem um número único)
// Como encontrar o GID:
//   1. Abra sua planilha no Google Sheets
//   2. Clique na aba (ex: "2021")
//   3. Olhe a URL — aparece: #gid=XXXXXXXXX
//   4. Copie esse número e cole abaixo
//
const SHEET_GIDS = {
  '2020': '113805579',   // ✅ Confirmado
  '2021': 'COLE_AQUI',  // ← Clique na aba 2021 e copie o gid da URL
  '2022': 'COLE_AQUI',  // ← Clique na aba 2022 e copie o gid da URL
  '2023': 'COLE_AQUI',  // ← Clique na aba 2023 e copie o gid da URL
  '2024': 'COLE_AQUI',  // ← Clique na aba 2024 e copie o gid da URL
  '2025': 'COLE_AQUI',  // ← Clique na aba 2025 e copie o gid da URL
  '2026': 'COLE_AQUI',  // ← Clique na aba 2026 e copie o gid da URL
};
// ============================================================

// Converte valor monetário BR para número
function parseBRL(str) {
  if (!str || typeof str !== 'string') return 0;
  // Remove R$, espaços, pontos de milhar, troca vírgula por ponto
  const clean = str.replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.');
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

// Faz parse de uma linha CSV respeitando campos com aspas
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Busca e faz parse do CSV de uma aba
async function fetchSheet(year, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 8) continue;

      const mes = parseInt(cols[0]);
      const ano = parseInt(cols[1]) || parseInt(year);
      const empresa = (cols[2] || '').trim().toUpperCase();
      const modelo = (cols[4] || '').trim().toUpperCase();
      const valor = parseBRL(cols[5]);
      const enviadas = parseInt(cols[6]) || 0;
      const total = parseBRL(cols[7]);
      const pagoDia = (cols[8] || '').trim();

      if (!mes || !empresa || !total) continue;

      rows.push({ mes, ano, empresa, modelo, valor, enviadas, total, pagoDia });
    }
    console.log(`✅ Aba ${year}: ${rows.length} registros carregados`);
    return rows;
  } catch (err) {
    console.warn(`⚠️  Não foi possível carregar aba ${year} (gid=${gid}): ${err.message}`);
    return [];
  }
}

// Carrega todos os dados com fallback
async function loadAllData() {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return cache.data;
  }

  console.log('🔄 Atualizando cache de dados...');
  const allData = [];

  // Tenta carregar cada ano
  for (const [year, gid] of Object.entries(SHEET_GIDS)) {
    const rows = await fetchSheet(year, gid);
    allData.push(...rows);
  }

  // Fallback: se só carregou 2020, retorna pelo menos isso
  if (allData.length === 0) {
    console.warn('⚠️  Nenhum dado carregado! Verifique se a planilha está pública.');
  }

  cache.data = allData;
  cache.timestamp = now;
  return allData;
}

// Serve arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// API de dados
app.get('/api/data', async (req, res) => {
  try {
    const data = await loadAllData();

    // Filtros opcionais
    const { ano, empresa } = req.query;
    let filtered = data;
    if (ano && ano !== 'todos') filtered = filtered.filter(d => d.ano == ano);
    if (empresa && empresa !== 'todas') filtered = filtered.filter(d => d.empresa === empresa.toUpperCase());

    // Agrupamentos
    const anos = [...new Set(data.map(d => d.ano))].sort();
    const empresas = [...new Set(data.map(d => d.empresa))].sort();

    // Faturamento por ano
    const fatPorAno = {};
    data.forEach(d => {
      fatPorAno[d.ano] = (fatPorAno[d.ano] || 0) + d.total;
    });

    // Faturamento por mês (dos dados filtrados)
    const fatPorMes = Array(12).fill(0);
    const pecasPorMes = Array(12).fill(0);
    filtered.forEach(d => {
      if (d.mes >= 1 && d.mes <= 12) {
        fatPorMes[d.mes - 1] += d.total;
        pecasPorMes[d.mes - 1] += d.enviadas;
      }
    });

    // Faturamento por empresa (filtrado)
    const fatPorEmpresa = {};
    filtered.forEach(d => {
      fatPorEmpresa[d.empresa] = (fatPorEmpresa[d.empresa] || 0) + d.total;
    });

    // KPIs
    const totalFaturado = filtered.reduce((s, d) => s + d.total, 0);
    const totalPecas = filtered.reduce((s, d) => s + d.enviadas, 0);
    const totalEmpresasUnicas = new Set(filtered.map(d => d.empresa)).size;
    const totalPedidos = filtered.length;

    res.json({
      kpis: { totalFaturado, totalPecas, totalEmpresasUnicas, totalPedidos },
      anos,
      empresas,
      fatPorAno,
      fatPorMes,
      pecasPorMes,
      fatPorEmpresa,
      ultimos30: filtered.slice(-30).reverse(),
    });
  } catch (err) {
    console.error('Erro na API:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota raiz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  loadAllData(); // Pré-carrega os dados
});
