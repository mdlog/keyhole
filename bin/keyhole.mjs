#!/usr/bin/env node
// `keyhole` bin with no build step: register tsx's ESM loader, then run the TypeScript entry.
// Works after `npm link` (the package is private and never published; the npm name `keyhole` is taken).
import { register } from "tsx/esm/api";

register();
await import("../src/cli/index.ts");
