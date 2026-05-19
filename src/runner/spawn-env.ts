import type { InvocationRequest } from './invocation-result';

export function buildSpawnEnv(
  request: Pick<InvocationRequest, 'env' | 'inheritProcessEnv'>
): NodeJS.ProcessEnv {
  const overlay = request.env ?? {};
  if (request.inheritProcessEnv === false) {
    return { ...overlay };
  }
  return request.env ? { ...process.env, ...overlay } : process.env;
}
