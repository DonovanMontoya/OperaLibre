export const repositoryRoot: string;
export function devServerEnvironment(
  env?: Record<string, string | undefined>,
  cwd?: string
): Record<string, string | undefined>;
export function devProxyTarget(
  env?: Record<string, string | undefined>,
  cwd?: string
): string;
