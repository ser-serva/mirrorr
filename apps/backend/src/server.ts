import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { createDb, type Db } from './db/index.js';
import { creatorsPlugin } from './routes/creators.routes.js';
import { videosPlugin } from './routes/videos.routes.js';
import { eventsPlugin } from './routes/events.routes.js';
import { discoveryPlugin } from './routes/discovery.routes.js';
import { startup } from './index.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    loggedIn?: boolean;
  }
}

export async function buildServer(testDb?: Db) {
  const fastify = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // ── OpenAPI / Swagger ──────────────────────────────────────────────────────

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Mirrorr API',
        version: '1.0.0',
        description:
          'REST API for the Mirrorr video-mirror pipeline.\n\n' +
          '**Auth**: Call `POST /login` first — the browser session cookie is set automatically.',
      },
      tags: [
        { name: 'auth', description: 'Authentication' },
        { name: 'creators', description: 'Creator management' },
        { name: 'videos', description: 'Video records' },
        { name: 'events', description: 'Server-Sent Events stream' },
        { name: 'discovery', description: 'Discovery pipeline controls' },
        { name: 'system', description: 'Health and config' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: true,
  });

  // ── DB ─────────────────────────────────────────────────────────────────────

  const db = testDb ?? createDb().db;
  fastify.decorate('db', db);

  // ── Session ──────────────────────────────────────────────────────────────

  await fastify.register(secureSession, {
    secret: env.SESSION_SECRET,
    salt: env.SESSION_SALT,
    cookie: { path: '/', httpOnly: true, secure: false /* true in prod */ },
  });

  // ── Auth hook ─────────────────────────────────────────────────────────────

  fastify.addHook('onRequest', async (req, reply) => {
    const { url, method } = req;
    const isPublic =
      url === '/health' ||
      url === '/api/config' ||
      (url === '/login' && method === 'POST') ||
      url.startsWith('/assets/') ||
      url.startsWith('/documentation') ||
      url === '/';

    if (!isPublic && !req.session.get('loggedIn')) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ── Public routes ──────────────────────────────────────────────────────────

  fastify.get('/health', { schema: { tags: ['system'] } }, async () => ({
    ok: true,
    temporal: env.TEMPORAL_ADDRESS,
    db: env.DATABASE_PATH,
  }));

  fastify.get('/api/config', { schema: { tags: ['system'] } }, async () => ({
    temporalUiUrl: env.TEMPORAL_UI_URL ?? null,
  }));

  fastify.post(
    '/login',
    { schema: { tags: ['auth'], body: z.object({ password: z.string() }) } },
    async (req, reply) => {
      if (req.body.password !== env.ADMIN_PASSWORD) {
        return reply.code(401).send({ error: 'Invalid password' });
      }
      req.session.set('loggedIn', true);
      return { ok: true };
    },
  );

  fastify.post('/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    req.session.delete();
    return { ok: true };
  });

  // ── Auth-required placeholder ──────────────────────────────────────────────

  fastify.get('/api/stats', { schema: { tags: ['system'] } }, async () => ({
    message: 'TODO — wire up DB queries',
  }));

  // ── API route plugins (all require auth via onRequest hook above) ──────────

  await fastify.register(creatorsPlugin, { prefix: '/api' });
  await fastify.register(videosPlugin, { prefix: '/api' });
  await fastify.register(eventsPlugin, { prefix: '/api' });
  await fastify.register(discoveryPlugin, { prefix: '/api' });

  return fastify;
}

async function main() {
  // Run DB migrations + register Temporal schedule (idempotent)
  await startup();

  const server = await buildServer();

  await server.listen({ port: env.PORT, host: env.HOST });
  console.log(`🚀 API server running on http://${env.HOST}:${env.PORT}`);
}

// Only start the server when this file is run directly (not when imported in tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Server crashed:', err);
    process.exit(1);
  });
}
