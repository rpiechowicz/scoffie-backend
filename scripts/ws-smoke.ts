import { io } from 'socket.io-client';

async function main(): Promise<void> {
  const event = process.argv[2];
  const payloadRaw = process.argv[3] ?? '{}';
  const url = process.env.WS_URL ?? 'http://localhost:3000';
  const timeoutMs = Number(process.env.WS_TIMEOUT_MS ?? '5000');

  if (!event) {
    console.error(
      "Usage: pnpm tsx scripts/ws-smoke.ts <event> '<json-payload>'",
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

  const socket = io(url, {
    transports: ['websocket'],
    timeout: timeoutMs,
  });

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
