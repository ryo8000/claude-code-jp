#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    // ディレクトリ名は外部入力のため、osascriptに渡すAppleScript文字列を壊さない
    // （かつ任意コード注入を防ぐ）よう、改行を除去しバックスラッシュとダブルクォートを
    // エスケープする。改行はダブルクォートをエスケープ済みでも文字列リテラルを構文エラーにする。
    const dirName = (input.cwd ? path.basename(input.cwd) : '')
      .replace(/[\r\n]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
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
