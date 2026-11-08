#!/usr/bin/env node
'use strict';

// FR-R5-F35 (F35-T02) — Controlled local CLI fixture speaking real runner framing.
// Supports: success, incomplete, credit-limited, malformed, slow, failed-start, uncertain-spawn.
// Rejects any unexpected remote network access.

const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.SCHEGENT_FIXTURE_MODE || 'success';
const outputPath = process.env.SCHEGENT_FIXTURE_OUTPUT_PATH || '';
const sideEffectPath = process.env.SCHEGENT_FIXTURE_SIDE_EFFECT_PATH || '';
const payloadJson = process.env.SCHEGENT_FIXTURE_RESULT_JSON || '';

if (process.env.SCHEGENT_FIXTURE_REMOTE_URL) {
  process.stderr.write('FATAL: Remote network access is forbidden in controlled CLI fixtures.\n');
  process.exit(99);
}

if (mode === 'failed-start') {
  process.stderr.write('spawn EACCES: controlled startup failure before acknowledgement\n');
  process.exit(126);
}

if (mode === 'uncertain-spawn') {
  if (sideEffectPath) {
    fs.mkdirSync(path.dirname(sideEffectPath), { recursive: true });
    fs.writeFileSync(sideEffectPath, 'uncommitted-side-effect\n', { mode: 0o600 });
  }
  process.stderr.write('Simulated crash after side effect before completion marker\n');
  process.exit(137);
}

if (mode === 'credit-limited') {
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, '{"approved":true,"note":"truncated partial output"}', {
      mode: 0o600
    });
  }
  process.stderr.write("You've hit your usage limit. Try again at 2:15 PM.\n");
  process.exit(1);
}

if (mode === 'malformed') {
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, '{malformed-json-without-closing-brace', { mode: 0o600 });
  }
  process.stdout.write('Completed phase run with malformed structured output.\n');
  process.exit(0);
}

if (mode === 'incomplete') {
  const body =
    payloadJson ||
    JSON.stringify({
      done: true,
      approved: false,
      pending_tasks: 1,
      score: 68,
      nextFeedback: 'Address remaining review finding'
    });
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body, { mode: 0o600 });
  }
  process.stdout.write(`${body}\n`);
  process.exit(0);
}

const defaultSuccessBody =
  payloadJson ||
  JSON.stringify({
    done: true,
    approved: true,
    pending_tasks: 0,
    score: 96,
    nextFeedback: 'All findings resolved'
  });

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, defaultSuccessBody, { mode: 0o600 });
}
process.stdout.write(`${defaultSuccessBody}\n`);
process.exit(0);

