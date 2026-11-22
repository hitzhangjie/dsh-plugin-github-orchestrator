/**
 * Small dependency-free helpers shared by every module.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Read a JSON file, returning `fallback` when it is missing or unreadable. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON through a temporary sibling plus rename so readers never see a half file. */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

export function slugify(text, max = 48) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export function shortHash(text, len = 8) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, len);
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function redactToken(text) {
  return String(text ?? '').replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
}

export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
}
