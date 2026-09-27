// Placeholder until the zod-validated env schema lands; keep parsing rules here so apps never read process.env directly.
const DEFAULT_API_PORT = 3000;

export function getApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.API_PORT;
  if (raw === undefined || raw === '') return DEFAULT_API_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`API_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}
