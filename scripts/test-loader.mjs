/**
 * `resolve` hook making the project's TypeScript sources importable by Node's
 * built-in test runner.
 *
 * Node neither reads `tsconfig.json` path aliases nor resolves extensionless
 * specifier imports (both are bundler features). This hook rewrites:
 *
 * - `@/foo/bar` → `<projectRoot>/src/foo/bar.ts` (the tsconfig alias), and
 * - `./foo`     → the sibling `./foo.ts` when the specifier has no extension,
 *
 * then hands the absolute, fully-specified URL to Node's default resolver.
 * Test-time only: never part of the application bundle, and it does no I/O.
 */

/**
 * @param {string} specifier
 * @param {{ parentURL: string | undefined }} context
 * @param {(specifier: string, context: unknown) => unknown} nextResolve
 */
/**
 * Bare specifiers that have no runtime implementation of their own.
 *
 * Next.js implements `import "server-only"` / `import "client-only"` at the
 * compiler level — the marker only exists to keep a module out of the wrong
 * bundle — so it intentionally never installs those packages
 * (`next/types/global.d.ts`). TypeScript agrees and skips side-effecting
 * imports. Node's own resolver has no such special case, and without this
 * mapping every test touching a server module would die on resolution. An empty
 * module is the markers' entire behaviour on the server.
 */
const COMPILER_ONLY_MARKERS = new Set(["server-only", "client-only"]);

const EMPTY_MODULE = new URL("data:text/javascript,");

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier !== "string") {
    return nextResolve(specifier, context);
  }

  if (COMPILER_ONLY_MARKERS.has(specifier)) {
    return { url: EMPTY_MODULE.href, shortCircuit: true, format: "module" };
  }

  let url;
  if (specifier.startsWith("@/")) {
    const projectRoot = new URL("../", import.meta.url);
    url = new URL(`./src/${specifier.slice(2)}`, projectRoot);
  } else if (specifier.startsWith(".")) {
    url = new URL(specifier, context.parentURL ?? import.meta.url);
  } else {
    return nextResolve(specifier, context);
  }

  const target = url.href;
  if (hasExtension(target)) {
    return nextResolve(target, context);
  }
  return nextResolve(`${target}.ts`, context);
}

/** True only when the final path segment carries a file extension. */
function hasExtension(fileUrl) {
  const pathname = new URL(fileUrl).pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[^/]+$/.test(lastSegment);
}
