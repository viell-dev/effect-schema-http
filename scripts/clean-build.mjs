import { rmSync } from "node:fs";
import { URL } from "node:url";

// Remove obsolete modules before compiling a fresh distribution.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
