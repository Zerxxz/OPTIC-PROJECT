/**
 * Ambient type declarations for asset imports.
 * Vite handles these via its built-in client types; this file
 * exists to silence noUnusedLocals for type-only re-exports.
 */
declare module '*.svg' {
  const url: string;
  export default url;
}

declare module '*.mjs' {
  const value: Record<string, unknown>;
  export default value;
}
