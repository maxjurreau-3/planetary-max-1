import { Hono } from 'hono';

type KernelEnvelope = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  identity: string;
  governanceContext: Record<string, unknown>;
};

type KernelService = {
  fetch(request: Request): Promise<Response>;
};

type Bindings = {
  KERNEL_SERVICE?: KernelService;
  KERNEL_URL?: string;
};

type KernelResult = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

// ⭐ ROOT ROUTE — this fixes the 404 at /
app.get('/', (c) => {
  return c.json({
    status: 'Portal‑OS live',
    worker: 'planetary-max',
    mode: c.env.PLANETARY_MODE,
    umbrella: c.env.UMBRELLA_ENFORCEMENT
  });
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'portal-os-worker' }));

app.post('/api/kernel/message', async (c) => {
  const identity = bearerToken(c.req.header('Authorization'));
  if (!identity) return c.json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Bearer token required' } }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be JSON' } }, 400);
  }
  if (!isRecord(body) || typeof body.type !== 'string') {
    return c.json({ ok: false, error: { code: 'INVALID_MESSAGE', message: 'type and object payload are required' } }, 400);
  }
  const payload = body.payload === undefined ? {} : body.payload;
  if (!isRecord(payload)) {
    return c.json({ ok: false, error: { code: 'INVALID_MESSAGE', message: 'type and object payload are required' } }, 400);
  }
  const envelope = createEnvelope(
    body.type,
    payload,
    identity,
    isRecord(body.governanceContext) ? body.governanceContext : {},
  );
  return kernelResponse(c.env, envelope);
});

app.get('/universe/state', async (c) => universeRequest(c.env, c.req.header('Authorization'), 'universe.state', {}));
app.get('/universe/umbrella', async (c) => universeRequest(c.env, c.req.header('Authorization'), 'universe.umbrella', {}));
app.post('/universe/tick', async (c) => {
  let payload: Record<string, unknown> = {};
  const contentType = c.req.header('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body: unknown = await c.req.json();
      if (!isRecord(body)) return c.json({ ok: false, error: { code: 'INVALID_JSON', message: 'Tick payload must be an object' } }, 400);
      payload = body;
    } catch {
      return c.json({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be JSON' } }, 400);
    }
  }
  return universeRequest(c.env, c.req.header('Authorization'), 'universe.tick', payload);
});

async function universeRequest(
  env: Bindings,
  authorization: string | undefined,
  type: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const identity = bearerToken(authorization);
  if (!identity) {
    return Response.json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Bearer token required' } }, { status: 401 });
  }
  return kernelResponse(env, createEnvelope(type, payload, identity, { surface: 'worker-universe' }));
}

function createEnvelope(
  type: string,
  payload: Record<string, unknown>,
  identity: string,
  governanceContext: Record<string, unknown>,
): KernelEnvelope {
  return { id: crypto.randomUUID(), type, payload, identity, governanceContext };
}

async function kernelResponse(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  try {
    const response = await callKernel(env, envelope);
    const result = await response.json<KernelResult>();
    const status = result.ok === false ? kernelErrorStatus(result.error?.code) : response.status;
    return Response.json(result, { status });
  } catch (error) {
    console.error('Worker to kernel bridge failed', error);
    return Response.json(
      { ok: false, error: { code: 'KERNEL_UNAVAILABLE', message: 'Kernel bridge unavailable' } },
      { status: 503 },
    );
  }
}

async function callKernel(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  const body = JSON.stringify(envelope);
  const request = new Request('http://kernel/api/kernel/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (env.KERNEL_SERVICE) return env.KERNEL_SERVICE.fetch(request);
  if (env.KERNEL_URL) {
    const target = `${env.KERNEL_URL.replace(/\/$/, '')}/api/kernel/message`;
    return fetch(target, { method: 'POST', headers: request.headers, body });
  }
  throw new Error('Configure KERNEL_SERVICE or KERNEL_URL');
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}

function kernelErrorStatus(code: string | undefined): number {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'INVALID_MESSAGE' || code === 'INVALID_JSON') return 400;
  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { app, createEnvelope };
export default app;
