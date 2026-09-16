// `import-in-the-middle` ships types as `register-hooks.d.ts`, which TypeScript won't match to the
// `.mjs` specifier the package requires under nodenext resolution (it looks for `register-hooks.d.mts`)
// — and the package declares no "exports" map to redirect it. Declaring the two functions we call is
// cheaper and clearer than reaching into the package's internals to satisfy the resolver.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
  }): void;

  export function supportsSyncHooks(): boolean;
}
