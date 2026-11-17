import type { EventEmitter } from "node:events";

interface Resposta {
  statusCode: number;
}

// Status que indicam que a Cloudflare barrou a requisição (rate limit / anti-DDoS)
// em vez de a aplicação ter respondido. Se esse contador subir, o resultado do
// teste está medindo o bloqueio, não a aplicação.
const STATUS_DE_BLOQUEIO = new Set([403, 429, 503]);

export async function contarRespostas(
  _req: unknown,
  res: Resposta,
  _contexto: unknown,
  eventos: EventEmitter,
): Promise<void> {
  if (STATUS_DE_BLOQUEIO.has(res.statusCode)) {
    eventos.emit("counter", "lp.bloqueio_cloudflare", 1);
  } else if (res.statusCode >= 400) {
    eventos.emit("counter", "lp.status_inesperado", 1);
  }
}
