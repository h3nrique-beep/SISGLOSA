const fs = require('node:fs');

const MAX_BODY_SIZE = 1_000_000;
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const CSP = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";

const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

function json(response, status, value, headers = {}) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
}
const fail = (response, status, message) => json(response, status, { error: message });
function html(response, content) { response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' }).end(content); }
function serve(response, file, type) {
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': type,
    'Cache-Control': /^(font|image)\//.test(type) ? 'public, max-age=86400' : 'no-store',
    ...(type.includes('text/html') ? { 'Content-Security-Policy': CSP } : {}),
  });
  response.end(fs.readFileSync(file));
}

const cookie = (request, name) => Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim().split('=')))[name];
// Atrás do Nginx toda conexão chega de 127.0.0.1; o proxy grava o IP real em X-Real-IP, aceito só vindo do loopback.
function clientAddress(request) {
  const ip = request.socket.remoteAddress;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && request.headers['x-real-ip'] ? String(request.headers['x-real-ip']) : (ip || 'unknown');
}

function body(request) {
  return new Promise((resolve, reject) => {
    let data = '', tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => { if (tooLarge) return; if (data.length + chunk.length > MAX_BODY_SIZE) { tooLarge = true; return; } data += chunk; });
    request.on('end', () => {
      if (tooLarge) return reject(httpError(413, 'A solicitação excede o limite permitido.'));
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Dados inválidos.')); }
    });
    request.on('error', reject);
  });
}
function rawBody(request, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size <= maxSize) chunks.push(chunk); });
    request.on('end', () => size > maxSize ? reject(httpError(413, 'O pacote excede o limite de 25 MB.')) : resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

module.exports = { securityHeaders, escape, money, httpError, json, fail, html, serve, cookie, clientAddress, body, rawBody };
