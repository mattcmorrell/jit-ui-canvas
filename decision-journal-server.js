const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3334;
const ROOT = __dirname;
const JSON_FILE = path.join(ROOT, 'product-decisions.json');

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

// SSE clients for live-reload
const sseClients = new Set();

// Watch product-decisions.json for changes
let lastMtime = 0;
try { lastMtime = fs.statSync(JSON_FILE).mtimeMs; } catch {}

fs.watchFile(JSON_FILE, { interval: 500 }, (curr) => {
  if (curr.mtimeMs !== lastMtime) {
    lastMtime = curr.mtimeMs;
    for (const res of sseClients) {
      res.write('event: reload\ndata: {}\n\n');
    }
  }
});

const server = http.createServer((req, res) => {
  // SSE endpoint for live-reload
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Static file serving
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/decision-journal.html';
  const filePath = path.join(ROOT, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    // No cache for JSON so live-reload always gets fresh data
    if (ext === '.json') {
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use — journal server may already be running.`);
    console.log(`Open http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Decision journal running at http://localhost:${PORT}`);
});
