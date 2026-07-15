// Freeze the Python (FastAPI) sidecar into a self-contained onedir bundle with
// PyInstaller, so the packaged app needs no Python on the user's machine.
//
// Run directly (`npm run build:server`) or via `tauri build`, which chains it.
// It prefers the project virtualenv (server/.venv) that already has the runtime
// requirements installed, installs PyInstaller into it once if missing, then
// runs the spec. Output lands in server/dist/camera-roll-server/.
//
// This is a BUILD-time dependency only: it runs on the machine that produces the
// installer, never on the end user's machine.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverDir = join(repoRoot, "server");
const spec = join(serverDir, "camera-roll-server.spec");

// Pinned so the frozen bundle is reproducible across build machines.
const PYINSTALLER_SPEC = "pyinstaller==6.11.1";

function resolvePython() {
  const venv =
    process.platform === "win32"
      ? join(serverDir, ".venv", "Scripts", "python.exe")
      : join(serverDir, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function run(python, args, label) {
  console.log(`\n[build-server] ${label}`);
  const res = spawnSync(python, args, { stdio: "inherit", cwd: serverDir });
  if (res.error) {
    console.error(`[build-server] failed to launch ${python}:`, res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[build-server] ${label} exited with code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

const python = resolvePython();
console.log(`[build-server] using interpreter: ${python}`);

// Ensure PyInstaller is available in this interpreter; install it once if not.
const check = spawnSync(python, ["-m", "PyInstaller", "--version"], {
  stdio: "ignore",
  cwd: serverDir,
});
if (check.status !== 0) {
  run(python, ["-m", "pip", "install", PYINSTALLER_SPEC], "installing PyInstaller");
}

run(
  python,
  [
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--distpath",
    join(serverDir, "dist"),
    "--workpath",
    join(serverDir, "build"),
    spec,
  ],
  "freezing sidecar with PyInstaller",
);

console.log(
  "\n[build-server] done -> server/dist/camera-roll-server/camera-roll-server.exe",
);
