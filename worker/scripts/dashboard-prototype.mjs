// Isolated UI exploration. Never serves production data or calls the Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const page = new URL('../src/dashboard.prototype.html', import.meta.url);
createServer(async (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(await readFile(page));
}).listen(8790, '0.0.0.0', () => console.log('Dashboard mockup: http://localhost:8790/'));
