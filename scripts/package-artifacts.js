#!/usr/bin/env node
// package-artifacts.js — 零依赖打包：chrome-mv3 → zip + crx3（按 Chromium crx3 规范自实现）。
// 不用 wxt zip（隐式 rebuild 覆盖 postprocess 的 manifest）；不用弃维护的 npm crx3 包（Node 24 崩溃）。
// 用法: node scripts/package-artifacts.js --dir <chrome-mv3> [--zip out.zip] [--crx out.crx --key key.pem [--appid <32位ID>]]

import { parseArgs } from 'node:util';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, constants } from 'node:crypto';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    'zip-file': { type: 'string' },
    zip: { type: 'string' },
    crx: { type: 'string' },
    key: { type: 'string' },
    appid: { type: 'string' },
  },
});

if (values.crx && !values.key) {
  console.error('[pkg] --crx 需要 --key <private.pem>');
  process.exit(2);
}

// ==================== zip ====================

/** 递归收集文件，rel 用正斜杠（zip 规范） */
function collectFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, base, acc);
    else acc.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
  }
  return acc;
}

/** 固定 DOS 时间戳 2020-01-01 00:00（UTC）：构建可重现 */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 0x4A21

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const data = readFileSync(f.abs);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.rel, 'utf8');
    const crc = zlib.crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(8, 8); // method: deflate
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    locals.push(lfh, name, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(8, 10); // method
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset
    centrals.push(cdh, name);

    offset += 30 + name.length + comp.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, central, eocd]);
}

// ==================== protobuf 最小编码 ====================

function varint(n) {
  const bytes = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

/** length-delimited 字段（wire type 2），payload 为字节串 */
function bytesField(fieldNum, payload) {
  return Buffer.concat([varint((fieldNum << 3) | 2), varint(payload.length), payload]);
}

// ==================== crx3 ====================

const ID_ALPHABET = 'abcdefghijklmnop';

// crx3 = "Cr24" + LE32(3) + LE32(headerLen) + protobuf 头 + zip
//   header = { sha256_with_rsa: [proof], signed_header_data: sd }
//   proof  = { public_key: SPKI DER, signature }
//   sd     = { crx_id: SHA256(公钥) 前 16 字节 }
//   签名输入 = "CRX3 SignedData" + 0x00 + LE32(len(sd)) + sd + archive（RSA PKCS#1 v1.5 SHA-256）
function buildCrx3(zipBuf, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const pubDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxIdBytes = createHash('sha256').update(pubDer).digest().subarray(0, 16); // 16 字节原始二进制
  const appId = [...crxIdBytes].flatMap(b => [ID_ALPHABET[b >> 4], ID_ALPHABET[b & 0xf]]).join('');

  const sigLen = privateKey.asymmetricKeyType === 'rsa' ? (privateKey.asymmetricKeyDetails.modulusLength / 8) : 0;
  if (sigLen !== 256) {
    console.error(`[pkg] 仅支持 RSA 2048 私钥（当前模长 ${sigLen * 8} 位）`);
    process.exit(1);
  }

  // SignedData{ crx_id = 1 }：16 字节原始二进制
  const signedData = bytesField(1, crxIdBytes);

  // 签名输入 = "CRX3 SignedData\x00" + LE32(len(sd)) + sd + archive
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32LE(signedData.length, 0);
  const toSign = Buffer.concat([
    Buffer.from('CRX3 SignedData', 'latin1'),
    Buffer.from([0x00]),
    sizeField,
    signedData,
    zipBuf,
  ]);
  const signature = cryptoSign('sha256', toSign, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });

  // AsymmetricKeyProof{ public_key = 1, signature = 2 }
  const proof = Buffer.concat([bytesField(1, pubDer), bytesField(2, signature)]);

  // CrxFileHeader{ sha256_with_rsa = 2, signed_header_data = 10000 }
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedData)]);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4); // version 3
  prefix.writeUInt32LE(header.length, 8);

  return { crx: Buffer.concat([prefix, header, zipBuf]), appId };
}

// ==================== 主流程 ====================

if (!values.dir && !values['zip-file']) {
  console.error('用法: node scripts/package-artifacts.js --dir <chrome-mv3> [--zip <out.zip>] [--crx <out.crx> --key <private.pem> [--appid <32位ID>]]');
  console.error('      或 --zip-file <现成.zip> --crx <out.crx> --key <private.pem>（对已有 zip 重签 crx）');
  process.exit(2);
}

let zipBuf;
if (values['zip-file']) {
  if (!existsSync(values['zip-file'])) {
    console.error(`[pkg] zip 文件不存在: ${values['zip-file']}`);
    process.exit(2);
  }
  zipBuf = readFileSync(values['zip-file']);
  console.log(`[pkg] 读取现成 zip: ${values['zip-file']} (${(zipBuf.length / 1024).toFixed(1)} kB)`);
} else {
  const dir = path.resolve(values.dir);
  if (!existsSync(dir)) {
    console.error(`[pkg] 目录不存在: ${dir}`);
    process.exit(2);
  }
  const files = collectFiles(dir).sort((a, b) => a.rel.localeCompare(b.rel));
  if (files.length === 0) {
    console.error(`[pkg] 目录为空: ${dir}`);
    process.exit(1);
  }
  console.log(`[pkg] 打包 ${files.length} 个文件 ← ${dir}`);
  zipBuf = buildZip(files);
}

if (values.zip && !values['zip-file']) {
  writeFileSync(values.zip, zipBuf);
  console.log(`[pkg] zip: ${values.zip} (${(zipBuf.length / 1024).toFixed(1)} kB)`);
}

if (values.crx) {
  const keyPem = readFileSync(values.key, 'utf8');
  const { crx, appId } = buildCrx3(zipBuf, keyPem);
  if (values.appid && values.appid !== appId) {
    console.error(`[pkg] 扩展 ID 不匹配: 私钥算出 ${appId}，预期 ${values.appid}（检查 --key 与 --appid）`);
    process.exit(1);
  }
  writeFileSync(values.crx, crx);
  console.log(`[pkg] crx3: ${values.crx} (${(crx.length / 1024).toFixed(1)} kB), appid=${appId}`);
}
