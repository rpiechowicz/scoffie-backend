import { io } from 'socket.io-client';

/**
 * Ręczny smoke WebSocketu z uwierzytelnieniem.
 *
 *   WS_TOKEN=<jwt> pnpm ws:smoke <event> '<json>'
 *   pnpm ws:smoke --dev-login "Rafał" <event> '<json>'   (token z POST /auth/dev)
 *   pnpm ws:smoke <event> '<json>'                         (bez tokenu = legacy,
 *                                                           działa tylko w WS_AUTH_MODE=soft)
 *
 * Tożsamość bierze się z tokenu; `userId` w payloadzie jest ignorowane dla
 * socketu z tokenem (a rozjazd liczony w /ops/metrics.wsAuth.payloadMismatch).
 * Odmowa handshake'u wypisuje `{message, data:{code, reason, requestId}}`
 * i kończy kodem 2.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let devLoginName: string | null = null;
  const devLoginIndex = args.indexOf('--dev-login');
  if (devLoginIndex >= 0) {
    devLoginName = args[devLoginIndex + 1] ?? null;
    if (!devLoginName) {
      console.error('--dev-login wymaga nazwy użytkownika');
      process.exit(1);
    }
    args.splice(devLoginIndex, 2);
  }

  const event = args[0];
  const payloadRaw = args[1] ?? '{}';
  const url = process.env.WS_URL ?? 'http://localhost:3000';
  const timeoutMs = Number(process.env.WS_TIMEOUT_MS ?? '5000');

  if (!event) {
    console.error(
      "Usage: [WS_TOKEN=<jwt>] pnpm ws:smoke [--dev-login <name>] <event> '<json-payload>'",
    );
    process.exit(1);
  }

  let payload: unknown = {};
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    console.error('Payload must be valid JSON');
    process.exit(1);
  }

  let token = process.env.WS_TOKEN?.trim() || null;
  if (devLoginName) {
    token = await devLogin(url, devLoginName);
  }

  const socket = io(url, {
    transports: ['websocket'],
    timeout: timeoutMs,
    reconnection: false,
    ...(token ? { auth: { token } } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error: Error & { data?: unknown }) => {
      console.error(
        JSON.stringify({ message: error.message, data: error.data }, null, 2),
      );
      socket.close();
      process.exit(2);
    });
    setTimeout(
      () => reject(new Error(`No connection within ${timeoutMs} ms`)),
      timeoutMs,
    ).unref();
  });

  const response = await new Promise<unknown>((resolve, reject) => {
    socket
      .timeout(timeoutMs)
      .emit(event, payload, (err: unknown, ack: unknown) => {
        if (err) {
          reject(
            err instanceof Error
              ? err
              : new Error(typeof err === 'string' ? err : JSON.stringify(err)),
          );
          return;
        }
        resolve(ack);
      });
  });

  console.log(JSON.stringify(response, null, 2));
  socket.close();
}

async function devLogin(baseUrl: string, displayName: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  const body = (await response.json()) as {
    accessToken?: string;
    code?: string;
    message?: string;
  };
  if (!response.ok || !body.accessToken) {
    throw new Error(
      `dev-login failed (${response.status}): ${body.code ?? ''} ${body.message ?? ''}`.trim(),
    );
  }
  return body.accessToken;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
