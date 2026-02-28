const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const { startBot, getBotStatus, getMetrics } = require('./index');

const painelPath = path.join(__dirname, 'painel-web');
app.use('/painel-web', express.static(painelPath));

app.get('/', (_req, res) => {
  res.redirect('/painel-web/');
});

app.get('/api/status', async (_req, res) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    const metrics = await getMetrics();
    res.json({ ...metrics, botStatus: getBotStatus() });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao coletar status', detail: err.message });
  }
});

module.exports = { http };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  startBot().catch(() => {});
  http.listen(PORT, () => console.log(`Painel ativo em http://localhost:${PORT}/painel-web/`));
}
