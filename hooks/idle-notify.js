#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const dirName = input.cwd ? path.basename(input.cwd) : '';
    const body = dirName ? `${dirName} が入力待ちです` : '入力待ちです';

    const osa = spawn('osascript', ['-e', `display notification "${body}" with title "Claude Code"`], {
      detached: true,
      stdio: 'ignore',
    });
    osa.on('error', () => {});
    osa.unref();
  } catch {
    // Notificationフックはブロック不可のため、失敗しても握りつぶして終了する
  }
}

main();
