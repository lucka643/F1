/**
 * version.js — single source of truth for the build version.
 *
 * Bump VERSION on every change that ships. It is rendered in the corner of the
 * screen so there is never any doubt about which build is actually running —
 * which matters here, because Chrome has already served stale modules once and
 * cost an evening of debugging a bug that was fixed on disk.
 */
export const VERSION = '0.8.2';
export const BUILD_NAME = 'Highway Battle';
