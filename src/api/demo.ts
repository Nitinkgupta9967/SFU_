import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const root = resolve('dist/client/demo');
const clientRoot = resolve('dist/client');
const sourceIndex = resolve('client/demo/index.html');

export function registerDemoRoutes(app: FastifyInstance): void {
  app.get('/demo', async (_request, reply) => {
    const html = await readFile(sourceIndex, 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: { '*': string } }>('/demo/*', async (request, reply) => {
    return sendStatic(reply, root, request.params['*']);
  });

  app.get<{ Params: { '*': string } }>('/client/*', async (request, reply) => {
    return sendStatic(reply, clientRoot, request.params['*']);
  });

  app.get('/SfuClient.js', async (_request, reply) => {
    return sendStatic(reply, clientRoot, 'SfuClient.js');
  });
}

function sendStatic(reply: FastifyReply, base: string, path: string) {
  const requested = normalize(path);
  const file = resolve(join(base, requested));
  if (!file.startsWith(base) || !existsSync(file)) {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'asset not found' } });
  }
  return reply.type(contentType(file)).send(createReadStream(file));
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
