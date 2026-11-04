// Model-check the TLA+ specs in tla/ with TLC (docs/TLA.md). Fetches the pinned tla2tools.jar once into .cache/tla,
// checks its SHA-256, runs every tla/*.cfg and exits non-zero on any violation, deadlock or error.
//
//   npm run tla                          every model
//   TLA_ONLY=Topology.n4 npm run tla     one model (a cfg's file name without .cfg)
//
// A cfg checks the spec named by its file name up to the first dot: Topology.n4.cfg checks Topology.tla.
// Needs Java 11 or later on PATH (or JAVA_HOME).
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SPECS = join(ROOT, "tla")
const CACHE = join(ROOT, ".cache", "tla")
const VERSION = "1.7.4"
const JAR_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar`
// Recorded when the version was pinned: GitHub lists no digest for this release.
const JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
const JAR = join(CACHE, `tla2tools-${VERSION}.jar`)
const ONLY = process.env.TLA_ONLY

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

async function ensureJar() {
  if (existsSync(JAR) && sha256(readFileSync(JAR)) === JAR_SHA256) return
  mkdirSync(CACHE, { recursive: true })
  console.log(`tla: fetching tla2tools.jar ${VERSION}`)
  const res = await fetch(JAR_URL)
  if (!res.ok) throw new Error(`tla: ${JAR_URL}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== JAR_SHA256) throw new Error(`tla: tla2tools.jar SHA-256 is ${got}, expected ${JAR_SHA256}`)
  const tmp = `${JAR}.part`
  writeFileSync(tmp, buf)
  renameSync(tmp, JAR)
}

// JAVA_HOME when it holds a java (it can be stale, e.g. copied from another machine's shell profile), else PATH.
function java() {
  const home = process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "java")
  return home && existsSync(home) ? home : "java"
}

function check(model) {
  const spec = `${model.split(".")[0]}.tla`
  if (!existsSync(join(SPECS, spec))) throw new Error(`tla: ${model}.cfg has no ${spec}`)
  // TLC's working files (states, fingerprints) go to the cache, so tla/ stays clean.
  const meta = join(CACHE, "states", model)
  rmSync(meta, { recursive: true, force: true })
  const args = ["-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC", "-workers", "auto", "-metadir", meta, "-config", `${model}.cfg`, spec]
  console.log(`\ntla: ${model} (${spec})`)
  const t0 = performance.now()
  const run = spawnSync(java(), args, { cwd: SPECS, stdio: "inherit" })
  const seconds = ((performance.now() - t0) / 1000).toFixed(1)
  if (run.error) throw new Error(`tla: could not run ${java()} (${run.error.message}); TLC needs Java 11 or later`)
  return { model, ok: run.status === 0, status: run.status, seconds }
}

await ensureJar()
const models = readdirSync(SPECS)
  .filter((f) => f.endsWith(".cfg"))
  .map((f) => f.slice(0, -".cfg".length))
  .filter((m) => !ONLY || m === ONLY)
  .sort()
if (models.length === 0) throw new Error(ONLY ? `tla: no tla/${ONLY}.cfg` : "tla: no models in tla/")

const results = models.map(check)
console.log("")
for (const r of results) console.log(`tla: ${r.ok ? "ok  " : "FAIL"} ${r.model} in ${r.seconds} s${r.ok ? "" : ` (TLC exit ${r.status})`}`)
if (results.some((r) => !r.ok)) process.exit(1)
