import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from './env.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    loggedIn?: boolean;
  }
}

export async function buildServer() {
  const fastify = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

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
      url === '/';

    if (!isPublic && !req.session.get('loggedIn')) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ── Public routes ──────────────────────────────────────────────────────────

  fastify.get('/health', async () => ({
    ok: true,
    temporal: env.TEMPORAL_ADDRESS,
    db: env.DATABASE_PATH,
  }));

  fastify.get('/api/config', async () => ({
    temporalUiUrl: env.TEMPORAL_UI_URL ?? null,
  }));

  fastify.post(
    '/login',
    { schema: { body: z.object({ password: z.string() }) } },
    async (req, reply) => {
      if (req.body.password !== env.ADMIN_PASSWORD) {
        return reply.code(401).send({ error: 'Invalid password' });
      }
      req.session.set('loggedIn', true);
      return { ok: true };
    },
  );

  fastify.post('/logout', async (req, reply) => {
    req.session.delete();
    return { ok: true };
  });

  // ── Auth-required placeholder ──────────────────────────────────────────────

  fastify.get('/api/stats', async () => ({
    message: 'TODO — wire up DB queries',
  }));

  return fastify;
}

async function main() {
  const server = await buildServer();

  await server.listen({ port: env.PORT, host: env.HOST });
  console.log(`🚀 API server running on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error('Server crashed:', err);
  process.exit(1);
});
