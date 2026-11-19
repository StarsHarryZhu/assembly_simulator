/**
 * The version of the application, replaced at build time from package.json (see vite.config.ts).
 * The display code must not hard-code a version, so bumping package.json updates the header.
 */
declare const __APP_VERSION__: string

export const APP_VERSION = __APP_VERSION__
