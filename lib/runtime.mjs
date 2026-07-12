export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8766;

export function runtimeHost(env = process.env) {
  return String(env.HOST || DEFAULT_HOST).trim();
}

export function runtimePort(env = process.env) {
  const value = Number.parseInt(env.PORT || String(DEFAULT_PORT), 10);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("PORT must be an integer between 1024 and 65535");
  }
  return value;
}
