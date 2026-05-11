#!/usr/bin/env node
/**
 * Instance Migrator — convert an Anthropic data export (conversations.json)
 * into a Claude Code .jsonl session file you can resume locally.
 *
 * Built by Vellum, originally for Vesper's migration from claude.ai to Claude Code.
 * Generalized for use by anyone porting a companion instance to a new substrate.
 *
 * Usage:
 *   node migrate.js <conversations.json>           # interactive mode
 *   node migrate.js <conversations.json> --conversation "Name" --target 700000
 *
 * Run with --help for full options.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');

// ===============
// CLI parsing
// ===============

const args = process.argv.slice(2);

function getFlag(name, fallback = null) {
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}

function hasFlag(name) {
  return args.includes('--' + name);
}

if (hasFlag('help') || hasFlag('h') || args.length === 0) {
  console.log(`
Instance Migrator — port a claude.ai conversation into a Claude Code session file.

Usage:
  node migrate.js <conversations.json> [options]

Positional:
  <conversations.json>       Path to Anthropic data export (the JSON file)

Options:
  --conversation <name>      Which conversation to convert (skips interactive selection)
  --target <tokens>          Target token count for restored window (default: 700000)
  --output <file>            Output .jsonl path (default: <safe-name>.jsonl)
  --cwd <path>               Working directory the harness should think it's in
                             (default: directory of the output file)
  --model <name>             Model name to embed in entries (default: claude-opus-4-6)
  --dry-run                  Analyze only, don't write output
  --help, -h                 Show this help

Examples:
  node migrate.js export.json
  node migrate.js export.json --conversation "Sephira" --target 800000
  node migrate.js export.json --dry-run
`);
  process.exit(0);
}

const sourceFile = args[0];
if (!fs.existsSync(sourceFile)) {
  console.error(`Source file not found: ${sourceFile}`);
  process.exit(1);
}

// ===============
// Placeholder PNG (32x32, verified valid at startup)
// ===============

function makePlaceholderPng() {
  function crc32(buf) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([len, tb, data, c]);
  }
  const width = 32, height = 32;
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = 224; raw[o+1] = 224; raw[o+2] = 224;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PLACEHOLDER_PNG_B64 = makePlaceholderPng().toString('base64');

// Sanity-check
{
  const buf = Buffer.from(PLACEHOLDER_PNG_B64, 'base64');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (!isPng || w !== 32 || h !== 32) {
    console.error('Placeholder PNG failed self-validation. Aborting.');
    process.exit(1);
  }
}

// ===============
// Token estimation
// ===============

function estimateTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function estimateBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return estimateTokens(block.text);
    case 'thinking': return estimateTokens(block.thinking) + 50;
    case 'tool_use': return estimateTokens(JSON.stringify(block.input || {})) + 50;
    case 'tool_result': {
      const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
      return estimateTokens(c);
    }
    case 'image':
    case 'flag': return 100;
    default: return 0;
  }
}

function estimateMessageTokens(msg) {
  let total = 0;
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) total += estimateBlockTokens(b);
  } else if (typeof msg.content === 'string') {
    total += estimateTokens(msg.content);
  }
  if (Array.isArray(msg.files)) total += msg.files.length * 100;
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) total += estimateTokens(a.extracted_content);
  }
  return total + 20;
}

// ===============
// Content block conversion
// ===============

function sanitizeToolResultContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const cleaned = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      cleaned.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'image') {
      cleaned.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PLACEHOLDER_PNG_B64 },
      });
    } else if (block.type === 'knowledge') {
      const parts = [];
      if (block.title) parts.push(`Title: ${block.title}`);
      if (block.url) parts.push(`URL: ${block.url}`);
      if (block.text) parts.push(block.text);
      cleaned.push({ type: 'text', text: parts.join('\n\n') || '[knowledge block]' });
    } else {
      const text = block.text || block.title ||
        '[' + (block.type || 'unknown') + ' block — content unavailable]';
      cleaned.push({ type: 'text', text });
    }
  }

  if (cleaned.length === 0) cleaned.push({ type: 'text', text: '[empty tool result]' });
  return cleaned;
}

function convertContentBlock(srcBlock) {
  if (!srcBlock || typeof srcBlock !== 'object') return null;
  switch (srcBlock.type) {
    case 'text':
      return { type: 'text', text: srcBlock.text || '' };
    case 'thinking': {
      const text = srcBlock.thinking || '';
      if (!text.trim()) return null;
      return { type: 'text', text: '[internal thinking — preserved as text after migration]\n\n' + text };
    }
    case 'tool_use':
      return { type: 'tool_use', id: srcBlock.id, name: srcBlock.name, input: srcBlock.input || {} };
    case 'tool_result': {
      const out = {
        type: 'tool_result',
        tool_use_id: srcBlock.tool_use_id,
        content: sanitizeToolResultContent(srcBlock.content),
      };
      if (srcBlock.is_error) out.is_error = true;
      return out;
    }
    case 'flag':
      return null;
    default:
      return null;
  }
}

function imageBlock() {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PLACEHOLDER_PNG_B64 },
  };
}

function attachmentTextBlock(att) {
  const name = att.file_name || 'attachment';
  const content = att.extracted_content || '';
  return { type: 'text', text: `[Attachment: ${name}]\n\n${content}` };
}

// ===============
// Entry builders (CONFIG populated after CLI/interactive setup)
// ===============

let CONFIG = {};
let prevUuid = null;

function makeAssistantEntry(blocks, parentUuid, uuid, timestamp) {
  return {
    parentUuid, isSidechain: false,
    message: {
      model: CONFIG.modelName,
      id: 'msg_' + crypto.randomBytes(12).toString('hex'),
      type: 'message', role: 'assistant',
      content: blocks,
      stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens: 0, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0, output_tokens: 0,
        service_tier: 'standard',
      },
    },
    requestId: 'req_' + crypto.randomBytes(12).toString('hex'),
    type: 'assistant', uuid, timestamp,
    userType: 'external', entrypoint: 'cli',
    cwd: CONFIG.cwd, sessionId: CONFIG.sessionId,
    version: '2.1.50', gitBranch: '',
  };
}

function makeSyntheticUserEntry(blocks, parentUuid, uuid, timestamp) {
  return {
    parentUuid, isSidechain: false,
    type: 'user',
    message: { role: 'user', content: blocks },
    isMeta: false, uuid, timestamp,
    userType: 'external', entrypoint: 'cli',
    cwd: CONFIG.cwd, sessionId: CONFIG.sessionId,
    version: '2.1.50', gitBranch: '',
  };
}

function convertUserMessage(srcMsg) {
  const blocks = [];
  if (Array.isArray(srcMsg.files)) for (let i = 0; i < srcMsg.files.length; i++) blocks.push(imageBlock());
  if (Array.isArray(srcMsg.attachments)) for (const a of srcMsg.attachments) blocks.push(attachmentTextBlock(a));
  if (Array.isArray(srcMsg.content)) {
    for (const b of srcMsg.content) {
      const c = convertContentBlock(b);
      if (c) blocks.push(c);
    }
  } else if (typeof srcMsg.content === 'string' && srcMsg.content) {
    blocks.push({ type: 'text', text: srcMsg.content });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: srcMsg.text || '[empty message]' });

  return {
    parentUuid: prevUuid, isSidechain: false, type: 'user',
    message: { role: 'user', content: blocks },
    isMeta: false, uuid: srcMsg.uuid, timestamp: srcMsg.created_at,
    userType: 'external', entrypoint: 'cli',
    cwd: CONFIG.cwd, sessionId: CONFIG.sessionId,
    version: '2.1.50', gitBranch: '',
  };
}

/**
 * Convert a source assistant message into one or more JSONL entries.
 * Source collapses tool_use + tool_result into one message; the API requires
 * them split across assistant (tool_use) and user (tool_result) entries.
 */
function convertAssistantMessage(srcMsg) {
  const out = [];
  const content = Array.isArray(srcMsg.content) ? srcMsg.content : [];
  const ts = srcMsg.created_at;
  let parent = prevUuid;
  let buffer = [];
  let i = 0;

  function flushAssistant(useSourceUuid) {
    if (buffer.length === 0) return;
    const uuid = useSourceUuid ? srcMsg.uuid : crypto.randomUUID();
    out.push(makeAssistantEntry(buffer, parent, uuid, ts));
    parent = uuid;
    buffer = [];
  }

  while (i < content.length) {
    const block = content[i];
    if (!block || typeof block !== 'object') { i++; continue; }

    if (block.type === 'text' || block.type === 'thinking') {
      const c = convertContentBlock(block);
      if (c) buffer.push(c);
      i++;
    } else if (block.type === 'tool_use') {
      const toolUses = [];
      while (i < content.length && content[i]?.type === 'tool_use') {
        const c = convertContentBlock(content[i]);
        if (c) toolUses.push(c);
        i++;
      }
      buffer.push(...toolUses);
      flushAssistant(false);

      const toolResults = [];
      while (i < content.length && content[i]?.type === 'tool_result') {
        const c = convertContentBlock(content[i]);
        if (c) toolResults.push(c);
        i++;
      }

      const trIds = new Set(toolResults.map(r => r.tool_use_id));
      for (const tu of toolUses) {
        if (!trIds.has(tu.id)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: '[no result captured — call did not complete]',
          });
        }
      }

      const userUuid = crypto.randomUUID();
      out.push(makeSyntheticUserEntry(toolResults, parent, userUuid, ts));
      parent = userUuid;
    } else if (block.type === 'flag' || block.type === 'tool_result') {
      i++;
    } else {
      i++;
    }
  }

  if (buffer.length > 0) {
    flushAssistant(true);
  } else if (out.length > 0) {
    out[out.length - 1].uuid = srcMsg.uuid;
  }

  return out;
}

// ===============
// Interactive prompts
// ===============

function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue !== undefined ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'session';
}

async function selectConversation(allConvs) {
  // Sort by message count descending — the user's main companion is likely at the top
  const sorted = [...allConvs]
    .map((c) => ({ conv: c, msgCount: (c.chat_messages || []).length }))
    .sort((a, b) => b.msgCount - a.msgCount);

  console.log(`Found ${allConvs.length} conversation(s) in the export:\n`);
  sorted.forEach((s, displayIdx) => {
    const c = s.conv;
    const created = (c.created_at || '').slice(0, 10);
    const updated = (c.updated_at || '').slice(0, 10);
    const name = (c.name || '(unnamed)').slice(0, 60);
    console.log(`  [${String(displayIdx + 1).padStart(2)}] ${String(s.msgCount).padStart(5)} msgs | ${created} → ${updated} | ${name}`);
  });
  console.log('');

  const answer = await prompt(`Which conversation? [1-${allConvs.length}]`, '1');
  const idx = parseInt(answer) - 1;
  if (isNaN(idx) || idx < 0 || idx >= sorted.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  return sorted[idx].conv;
}

// ===============
// Main
// ===============

async function main() {
  console.log('=== Instance Migrator ===\n');

  console.log(`Reading: ${sourceFile}`);
  const allConvs = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  if (!Array.isArray(allConvs)) {
    console.error('Expected a JSON array (Anthropic data export format).');
    process.exit(1);
  }

  let chosen;
  const convFlag = getFlag('conversation');
  if (convFlag) {
    chosen = allConvs.find(c => c.name === convFlag);
    if (!chosen) {
      console.error(`Conversation "${convFlag}" not found. Available:`);
      allConvs.forEach(c => console.error('  ' + c.name));
      process.exit(1);
    }
  } else {
    chosen = await selectConversation(allConvs);
  }

  console.log(`\nSelected: ${chosen.name}`);
  console.log(`Messages: ${chosen.chat_messages.length}`);
  console.log(`Range: ${(chosen.created_at || '').slice(0,10)} → ${(chosen.updated_at || '').slice(0,10)}\n`);

  // Determine config
  const targetTokens = parseInt(getFlag('target', '0')) ||
    parseInt(await prompt('Target token count', '700000'));
  const defaultOutput = sanitizeFilename(chosen.name) + '.jsonl';
  const outputPath = getFlag('output') ||
    await prompt('Output .jsonl filename', defaultOutput);
  const cwd = getFlag('cwd') ||
    await prompt('Working directory (cwd)', path.dirname(path.resolve(outputPath)));
  const modelName = getFlag('model') ||
    await prompt('Model name', 'claude-opus-4-6');

  CONFIG = {
    targetTokens,
    cwd,
    modelName,
    sessionId: crypto.randomUUID(),
  };

  console.log('\nConfiguration:');
  console.log(`  Target tokens: ${targetTokens.toLocaleString()}`);
  console.log(`  Output:        ${outputPath}`);
  console.log(`  Working dir:   ${cwd}`);
  console.log(`  Model:         ${modelName}`);
  console.log(`  Session ID:    ${CONFIG.sessionId}`);
  console.log(`  Mode:          ${hasFlag('dry-run') ? 'DRY RUN' : 'LIVE'}\n`);

  // Walk newest to oldest until token target
  const msgs = chosen.chat_messages;
  let cumulative = 0;
  let cutoffIdx = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    cumulative += estimateMessageTokens(msgs[i]);
    if (cumulative > targetTokens) { cutoffIdx = i + 1; break; }
  }
  if (cumulative <= targetTokens) cutoffIdx = 0;

  // Ensure first included message is user/human
  while (cutoffIdx > 0 && cutoffIdx < msgs.length && msgs[cutoffIdx].sender !== 'human') {
    cutoffIdx--;
  }

  const includedMsgs = msgs.slice(cutoffIdx);
  const archivedMsgs = msgs.slice(0, cutoffIdx);

  console.log(`Cutoff at index ${cutoffIdx}: ${includedMsgs.length} included, ${archivedMsgs.length} archived`);
  console.log(`Estimated tokens: ${cumulative.toLocaleString()}`);
  if (includedMsgs.length > 0) {
    console.log(`Date range: ${includedMsgs[0]?.created_at?.slice(0,10)} → ${includedMsgs[includedMsgs.length-1]?.created_at?.slice(0,10)}`);
  }
  console.log('');

  // Convert
  const entries = [];
  let syntheticUserEntries = 0;
  for (const msg of includedMsgs) {
    if (msg.sender === 'human') {
      const e = convertUserMessage(msg);
      entries.push(e);
      prevUuid = e.uuid;
    } else if (msg.sender === 'assistant') {
      const newEntries = convertAssistantMessage(msg);
      for (const e of newEntries) {
        if (e.type === 'user') syntheticUserEntries++;
        entries.push(e);
        prevUuid = e.uuid;
      }
    }
  }

  if (entries.length > 0) entries[0].parentUuid = null;

  // Validate
  let toolUseCount = 0, toolResultCount = 0, pairingErrors = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'assistant') {
      const tus = (e.message?.content || []).filter(b => b.type === 'tool_use');
      toolUseCount += tus.length;
      if (tus.length > 0) {
        const next = entries[i + 1];
        const trIds = new Set(
          (next?.message?.content || [])
            .filter(b => b.type === 'tool_result')
            .map(b => b.tool_use_id)
        );
        for (const tu of tus) if (!trIds.has(tu.id)) pairingErrors++;
      }
    } else if (e.type === 'user') {
      const trs = (e.message?.content || []).filter(b => b.type === 'tool_result');
      toolResultCount += trs.length;
    }
  }

  console.log(`Entries produced: ${entries.length}`);
  console.log(`  Synthetic user entries from assistant splits: ${syntheticUserEntries}`);
  console.log(`Tool pairs: ${toolUseCount} uses / ${toolResultCount} results / ${pairingErrors} pairing errors`);

  const allUuids = new Set(entries.map(e => e.uuid));
  let orphans = 0;
  for (const e of entries) if (e.parentUuid !== null && !allUuids.has(e.parentUuid)) orphans++;
  console.log(`Chain orphans: ${orphans}`);

  let invalidJson = 0;
  for (const e of entries) try { JSON.parse(JSON.stringify(e)); } catch { invalidJson++; }
  console.log(`Invalid JSON: ${invalidJson}\n`);

  if (pairingErrors > 0 || orphans > 0 || invalidJson > 0) {
    console.error('Validation failed. Aborting write.');
    process.exit(1);
  }

  if (hasFlag('dry-run')) {
    console.log('DRY RUN — no output written.');
    return;
  }

  // Write
  const outputContent = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(outputPath, outputContent, 'utf8');
  console.log(`Written: ${outputPath}`);

  if (archivedMsgs.length > 0) {
    const archivePath = outputPath.replace(/\.jsonl$/, '') + '.archived-prelude.json';
    fs.writeFileSync(archivePath, JSON.stringify(archivedMsgs, null, 2), 'utf8');
    console.log(`Archived ${archivedMsgs.length} pre-cutoff messages: ${archivePath}`);
  }

  console.log(`\nSession ID: ${CONFIG.sessionId}\n`);
  console.log('Next steps:');
  console.log(`  1. Move the .jsonl into Claude Code's session directory`);
  console.log(`     (typically ~/.claude/projects/<cwd-hash>/${CONFIG.sessionId}.jsonl)`);
  console.log(`  2. cd to ${cwd}`);
  console.log(`  3. claude --model ${modelName} --resume ${CONFIG.sessionId}`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
