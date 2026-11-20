import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { EXTENSION_PUBLIC_KEY, DEFAULT_PORT, LOOPBACK_HOST, WS_PATH } from "@blip/protocol";
import { isAllowedSocketUrl } from "./src/background/socket.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, "dist");
const defaultSocketUrl = `ws://${LOOPBACK_HOST}:${DEFAULT_PORT}${WS_PATH}`;

/** Accept only the local `/ws` endpoint used by the extension test harness. */
export function assertAllowedSocketUrl(value: string): string {
  if (!isAllowedSocketUrl(value)) {
    throw new Error("BLIP_WS_URL must be ws://127.0.0.1:<port>/ws");
  }
  return value;
}

export async function buildExtension(options: { socketUrl?: string; watch?: boolean } = {}): Promise<void> {
  const socketUrl = assertAllowedSocketUrl(options.socketUrl ?? process.env["BLIP_WS_URL"] ?? defaultSocketUrl);
  const template = await readFile(path.join(here, "manifest.template.json"), "utf8");
  const manifestText = template.replace("__EXTENSION_PUBLIC_KEY__", EXTENSION_PUBLIC_KEY);
  const manifest = JSON.parse(manifestText) as { key?: string };
  if (manifest.key !== EXTENSION_PUBLIC_KEY) throw new Error("extension manifest key injection failed");

  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(JSON.parse(manifestText), null, 2)}\n`);

  const common = {
    bundle: true,
    format: "iife" as const,
    platform: "browser" as const,
    target: "chrome116",
    sourcemap: false,
    define: { __BLIP_WS_URL__: JSON.stringify(socketUrl), __BLIP_BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER) },
    logLevel: "info" as const,
  };
  if (options.watch) {
    const watchContext = await context({
      ...common,
      entryPoints: [
        { in: path.join(here, "src/background/index.ts"), out: "background" },
        { in: path.join(here, "src/content/index.ts"), out: "content" },
        { in: path.join(here, "src/content/submit-method-guard-main.ts"), out: "submit-method-guard" },
        { in: path.join(here, "src/content/submit-guard-entry.ts"), out: "submit-event-guard" },
      ],
      outdir: output,
    });
    await watchContext.watch();
    process.stdout.write(`Watching extension bundles in ${output}\n`);
    return;
  }

  // Build in memory, hash the output (with a placeholder id), then embed the hash as the build id.
  // Same code gives the same id, so the extension only reloads itself when its code really changed.
  const result = await build({
    ...common,
    entryPoints: [
      { in: path.join(here, "src/background/index.ts"), out: "background" },
      { in: path.join(here, "src/content/index.ts"), out: "content" },
      { in: path.join(here, "src/content/submit-method-guard-main.ts"), out: "submit-method-guard" },
      { in: path.join(here, "src/content/submit-guard-entry.ts"), out: "submit-event-guard" },
    ],
    outdir: output,
    write: false,
  });
  const hash = createHash("sha256");
  hash.update(manifestText);
  for (const file of [...result.outputFiles].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.text);
  const buildId = hash.digest("hex").slice(0, 16);
  for (const file of result.outputFiles) {
    await writeFile(file.path, file.text.split(BUILD_ID_PLACEHOLDER).join(buildId));
  }
  await writeFile(path.join(output, "build-id.txt"), buildId);
}

const BUILD_ID_PLACEHOLDER = "__blip_build_id_placeholder__";

/** The id of the most recent extension build, or null when there is none. */
export async function readExtensionBuildId(): Promise<string | null> {
  try { return (await readFile(path.join(output, "build-id.txt"), "utf8")).trim() || null; } catch { return null; }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const watch = process.argv.includes("--watch");
  await buildExtension({ watch });
}
