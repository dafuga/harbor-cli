import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const compiler = fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url))

if (!existsSync(compiler)) {
  // npm can propagate global mode to the Git checkout's dependency install (npm/cli#8440).
  // Install build dependencies in that checkout without re-entering prepare.
  execFileSync(process.execPath, [
    process.env.npm_execpath, 'ci', '--global=false', '--location=project',
    '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund',
  ], {stdio: 'inherit'})
}

execFileSync(process.execPath, [compiler], {stdio: 'inherit'})
