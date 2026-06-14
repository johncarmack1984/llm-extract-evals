import { readFileSync } from "node:fs";
import { extract } from "./extract";

// Extract a single document and print the structured result.
//   bun run src/run.ts <path-to-text-file>
const path = process.argv[2];
if (!path) {
  console.error("usage: bun run src/run.ts <path-to-text-file>");
  process.exit(1);
}

const text = readFileSync(path, "utf8");
const result = await extract(text);
console.log(JSON.stringify(result, null, 2));
