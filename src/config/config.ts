import { z } from 'zod';

/**
 * Load and validate process configuration from environment variables against an
 * app's zod schema. Call this once at boot: any missing or invalid variable
 * throws with a readable summary, so the process fails fast at startup instead
 * of at the first request that happens to need the bad value.
 *
 * Each app defines its own schema (e.g. `z.object({ PORT: z.coerce.number() })`)
 * and gets back a fully-typed, validated config object.
 *
 * @example
 *   const ConfigSchema = z.object({ DATABASE_URL: z.string().url() });
 *   const config = loadConfig(ConfigSchema);
 */
export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        return `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return result.data;
}
