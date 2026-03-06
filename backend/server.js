const path = require('path');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
const webRoot = path.resolve(__dirname, '../dist');

app.use('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'orchestra-backend' });
});

app.use(express.static(webRoot));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

app.listen(port, () => {
  console.log(`backend listening on ${port}`);
});
