import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? ".artifacts/packages");
await mkdir(target, { recursive: true });
await mkdir("assets", { recursive: true });
await copyFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  "assets/modelt-core.wasm",
);
const wasm = await readFile("assets/modelt-core.wasm");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  "assets/manifest.json",
  `${JSON.stringify({ version: pkg.version, abi: 1, sha256: createHash("sha256").update(wasm).digest("hex"), bytes: wasm.length }, null, 2)}\n`,
);
execFileSync("pnpm", ["pack", "--pack-destination", target], { stdio: "pipe" });
execFileSync(
  "cargo",
  [
    "package",
    "--allow-dirty",
    "--locked",
    "--manifest-path",
    "crates/modelt-core/Cargo.toml",
  ],
  { stdio: "pipe" },
);
const crate = `modelt-core-${pkg.version}.crate`;
await copyFile(
  `crates/modelt-core/target/package/${crate}`,
  resolve(target, crate),
);
await copyFile("assets/modelt-core.wasm", resolve(target, "modelt-core.wasm"));
await copyFile("assets/manifest.json", resolve(target, "wasm-manifest.json"));
console.log(`Verified npm, Cargo and Wasm artifacts: ${target}`);
