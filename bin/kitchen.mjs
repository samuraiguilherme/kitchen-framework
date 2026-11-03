#!/usr/bin/env node
// Runs the TypeScript CLI in place; the target repository is resolved from the caller's cwd.
import { register } from "tsx/esm/api";

register({ tsconfig: false });
await import("../src/cli.ts");
