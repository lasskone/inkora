/**
 * Registers the `@/*` alias resolver so Node's built-in test runner can import
 * project modules exactly as the application does. Wired up with
 * `node --import ./scripts/test-register.mjs --test …`.
 */
import { register } from "node:module";

register("./test-loader.mjs", import.meta.url);
