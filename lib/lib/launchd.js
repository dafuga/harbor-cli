import path from 'node:path';
import { harborHome } from './config.js';
function xmlEscape(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
export function renderLaunchdPlist(input) {
    const args = [input.command, ...(input.args ?? [])];
    const argXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
    const logBase = path.join(harborHome(), 'logs', input.label);
    const workingDirectory = input.workingDirectory
        ? `\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(input.workingDirectory)}</string>`
        : '';
    const keepAlive = input.restartOnFailure
        ? '<dict><key>SuccessfulExit</key><false/></dict>'
        : '<true/>';
    const throttle = input.restartOnFailure ? '\n  <key>ThrottleInterval</key>\n  <integer>2</integer>' : '';
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
  ${keepAlive}${throttle}
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.supervisorLog ?? `${logBase}.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.supervisorLog ?? `${logBase}.err.log`)}</string>
</dict>
</plist>
`;
}
