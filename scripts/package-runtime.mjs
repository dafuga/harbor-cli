import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {SERVICE_RUNTIMES} from '../lib/lib/artifacts.js'
import {releaseAsset, runtimeTarget} from '../lib/lib/runtime-host.js'

const [buildDir, outputDir, expectedTarget] = process.argv.slice(2)
const target = runtimeTarget()
if (!buildDir || !outputDir || expectedTarget !== target) {
  throw new Error(`usage: node scripts/package-runtime.mjs <build-dir> <output-dir> ${target}`)
}

await fs.mkdir(outputDir, {recursive: true})
const checksums = []
for (const {daemon} of SERVICE_RUNTIMES) {
  const asset = releaseAsset(daemon, target)
  const destination = path.join(outputDir, asset)
  await fs.copyFile(path.join(buildDir, daemon), destination)
  await fs.chmod(destination, 0o755)
  const digest = createHash('sha256').update(await fs.readFile(destination)).digest('hex')
  checksums.push(`${digest}  ${asset}\n`)
}
await fs.writeFile(path.join(outputDir, `SHASUMS256-${target}.txt`), checksums.sort().join(''))
