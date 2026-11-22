// Serves a benchmark folder to src/dev/harmonyLab.ts on 127.0.0.1 only:
//
//   node src/dev/bench-server.cjs <folder> [port]
//
// GET /manifest      <folder>/manifest.json (paths in it are relative to <folder>)
// GET /<path>        a file under <folder>
// POST /save/<name>  writes <folder>/results/<name>, read back as /results/<name>
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5199);
const results = path.join(root, 'results');
const TYPES = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.lab': 'text/plain; charset=utf-8', '.json': 'application/json' };

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'POST' && url.startsWith('/save/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.mkdirSync(results, { recursive: true });
        fs.writeFileSync(path.join(results, path.basename(url.slice(6))), Buffer.concat(chunks));
        res.end('ok');
      });
      return;
    }
    const file = path.resolve(root, url === '/manifest' ? 'manifest.json' : `.${url}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`bench folder ${root} on http://127.0.0.1:${port}`));
