import fs from "fs";
import path from "path";

// Your prompt wording lives in system-prompt.txt (plain text, no code).
// This file just loads it and fills in the codes from .env.local:
//   {{START_CODE}}  ->  START_CODE
//   {{END_CODE}}    ->  END_CODE
export function buildSystemPrompt(endCode) {
  const filePath = path.join(
    process.cwd(),
    "app",
    "api",
    "chat",
    "system-prompt.txt"
  );

  return fs
    .readFileSync(filePath, "utf8")
    .replaceAll("{{START_CODE}}", process.env.START_CODE ?? "")
    .replaceAll("{{END_CODE}}", endCode ?? process.env.END_CODE ?? "");
}
