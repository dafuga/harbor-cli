import path from 'node:path'
import {harborHome} from './config.js'

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function renderLaunchdPlist(input: {
  label: string
  command: string
  args?: string[]
  workingDirectory?: string
}): string {
  const args = [input.command, ...(input.args ?? [])]
  const argXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')
  const logBase = path.join(harborHome(), 'logs', input.label)
  const workingDirectory = input.workingDirectory
    ? `\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(input.workingDirectory)}</string>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>${workingDirectory}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(`${logBase}.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(`${logBase}.err.log`)}</string>
</dict>
</plist>
`
}
