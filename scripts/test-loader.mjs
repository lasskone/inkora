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
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier !== "string") {
    return nextResolve(specifier, context);
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
