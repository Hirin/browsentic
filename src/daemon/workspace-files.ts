import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { stateDir } from './lockfile';
import { codexHistory, savedCodexProjects } from './codex-history';
import { validCodexThreadId } from '@/lib/codex-history';
import { sealSecrets } from './guardrails/secrets';

const MAX_FILE = 1024 * 1024;
const MAX_PATCH = 128 * 1024;
const BLOCKED_PARTS = new Set(['.git', '.hg', '.svn', '.codex', '.ssh', '.aws', '.azure', '.gnupg', 'node_modules']);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class WorkspaceError extends Error {
  constructor(message: string, readonly code = 'WORKSPACE_BLOCKED') { super(message); }
}

interface Location { root?: number; path?: string }
export interface PreparedEdit {
  location: { root: number; path: string };
  sha256: string;
  oldText: string;
  newText: string;
  preview: { path: string; root: number; workspace: string; startLine: number; endLine: number; before: string; after: string };
}

/** Filesystem access is bound to native project metadata, never a path supplied by the agent. */
export class WorkspaceFiles {
  readonly roots: string[];
  private readonly identities: { dev: number; ino: number }[];
  constructor(readonly project: { id: string; name: string; roots: string[] }) {
    this.roots = [...new Set(project.roots.map((root) => {
      if (!isAbsolute(root)) throw new WorkspaceError('Project root is not an absolute local folder.');
      const canonical = realpathSync(root);
      if ([parse(canonical).root, homedir(), realpathSync(stateDir), join(homedir(), '.codex'), '/home', '/etc', '/usr', '/proc', '/sys', '/dev', '/run'].includes(canonical)) {
        throw new WorkspaceError('This folder is too broad for project file access.');
      }
      if (['.ssh', '.aws', '.azure', '.gnupg', '.config'].some((name) => within(canonical, join(homedir(), name)))) throw new WorkspaceError('Private system configuration is not a project workspace.');
      if (!lstatSync(canonical).isDirectory()) throw new WorkspaceError('Project folder is unavailable.');
      return canonical;
    }))];
    if (!this.roots.length) throw new WorkspaceError('Project has no available local folders.');
    this.identities = this.roots.map((root) => { const stat = lstatSync(root); return { dev: stat.dev, ino: stat.ino }; });
  }

  private location(input: unknown, allowFolder = false): { root: number; path: string; file: string } {
    const value = input as Location | null;
    const root = value?.root ?? 0;
    const path = value?.path ?? (allowFolder ? '.' : '');
    if (!Number.isInteger(root) || root < 0 || root >= this.roots.length || typeof path !== 'string' || path.length > 2048 || /[\0\\:\r\n]/.test(path) || isAbsolute(path)) {
      throw new WorkspaceError('Use a relative path and a valid project root index.');
    }
    const identity = lstatSync(this.roots[root]);
    if (identity.isSymbolicLink() || identity.dev !== this.identities[root].dev || identity.ino !== this.identities[root].ino || realpathSync(this.roots[root]) !== this.roots[root]) throw new WorkspaceError('The project folder changed. Select it again.');
    const parts = path === '.' && allowFolder ? [] : path.split('/');
    if (!parts.length && !allowFolder || parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || part !== part.trim() || protectedName(part))) {
      throw new WorkspaceError('Parent paths, credential files, internal configuration and dependency folders are not exposed.');
    }
    let current = this.roots[root];
    for (const part of parts) {
      current = join(current, part);
      if (!existsSync(current)) {
        // lstat still detects a dangling symlink, which existsSync deliberately does not.
        try { if (lstatSync(current).isSymbolicLink()) throw new WorkspaceError('Symlinks are not exposed.'); }
        catch (err) { if (err instanceof WorkspaceError) throw err; }
        continue;
      }
      if (lstatSync(current).isSymbolicLink()) throw new WorkspaceError('Symlinks are not exposed.');
    }
    return { root, path, file: join(this.roots[root], ...parts) };
  }

  list(input: unknown) {
    const { root, path, file } = this.location(input, true);
    if (!lstatSync(file).isDirectory()) throw new WorkspaceError('That path is not a folder.');
    const entries = readdirSync(file, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink() && !protectedName(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { root, path, roots: this.roots.map((root, index) => ({ index, name: basename(root) })), entries: entries.slice(0, 250).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 250 };
  }

  private contents(file: string): string {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceError('Only regular text files are supported.');
    if (stat.size > MAX_FILE) throw new WorkspaceError('File exceeds the 1 MiB project text limit.', 'FILE_TOO_LARGE');
    const buffer = readFileSync(file);
    if (buffer.length > MAX_FILE || buffer.includes(0)) throw new WorkspaceError('Binary or oversized files are not supported.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return buffer.toString('utf8'); }
    catch { throw new WorkspaceError('File is not UTF-8 text.'); }
  }

  read(input: unknown) {
    const { root, path, file } = this.location(input);
    const options = input as { startLine?: number; limit?: number };
    const startLine = options.startLine ?? 1;
    const limit = options.limit ?? 200;
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new WorkspaceError('Invalid line range.');
    const text = this.contents(file);
    const lines = text.split('\n');
    const content = lines.slice(startLine - 1, startLine - 1 + limit).map((line, index) => `${startLine + index}: ${line}`).join('\n');
    if (Buffer.byteLength(content) > MAX_PATCH) throw new WorkspaceError('Read a smaller range of lines.', 'FILE_TOO_LARGE');
    return { root, path, sha256: digest(text), lineCount: lines.length, startLine, content };
  }

  prepare(input: unknown): PreparedEdit {
    const location = this.location(input);
    const patch = input as { sha256?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown };
    const { sha256, startLine, endLine, text } = patch;
    if (typeof sha256 !== 'string' || !(sha256 === 'new' || /^[a-f0-9]{64}$/.test(sha256)) || typeof text !== 'string' || Buffer.byteLength(text) > MAX_PATCH || !Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new WorkspaceError('A patch needs the current sha256, a line range and replacement text.', 'INVALID_INPUT');
    }
    const first = startLine as number;
    const last = endLine as number;
    let oldText = '';
    if (existsSync(location.file)) {
      oldText = this.contents(location.file);
      if (sha256 !== digest(oldText)) throw new WorkspaceError('The file changed. Read it again before proposing an edit.', 'REVISION_MISMATCH');
    } else if (sha256 !== 'new') throw new WorkspaceError('The file does not exist. Use sha256="new" to create it.');
    const lines = oldText.split('\n');
    if (first < 1 || last < first - 1 || last > lines.length || first > lines.length + 1 || last - first > 500 || sha256 === 'new' && (first !== 1 || last !== 0)) {
      throw new WorkspaceError('The patch line range is outside the file.', 'INVALID_INPUT');
    }
    const before = lines.slice(first - 1, last).join('\n');
    if (Buffer.byteLength(before) > MAX_PATCH) throw new WorkspaceError('Propose a smaller patch.', 'FILE_TOO_LARGE');
    if (sealSecrets(before) !== before || sealSecrets(text) !== text) throw new WorkspaceError('This patch contains a credential. Change that value locally instead.');
    const replacement = text === '' ? [] : text.replaceAll('\r\n', '\n').split('\n');
    if (oldText.includes('\r\n')) for (let i = 0; i < replacement.length; i++) {
      if (i < replacement.length - 1 || last < lines.length) replacement[i] += '\r';
    }
    const newText = sha256 === 'new' ? text : [...lines.slice(0, first - 1), ...replacement, ...lines.slice(last)].join('\n');
    if (Buffer.byteLength(newText) > MAX_FILE) throw new WorkspaceError('Edited file would exceed the text limit.', 'FILE_TOO_LARGE');
    return { location: { root: location.root, path: location.path }, sha256, oldText, newText,
      preview: { path: location.path, root: location.root, workspace: this.roots[location.root], startLine: first, endLine: last, before, after: text } };
  }

  /** Called only after this exact prepared change has been approved by the user. */
  apply(edit: PreparedEdit) {
    const { file } = this.location(edit.location);
    const exists = existsSync(file);
    if (edit.sha256 === 'new' ? exists : !exists || digest(this.contents(file)) !== edit.sha256) {
      throw new WorkspaceError('The file changed while approval was pending. Read it and propose the edit again.', 'REVISION_MISMATCH');
    }
    const mode = exists ? lstatSync(file).mode & 0o777 : 0o644;
    const parent = dirname(file);
    const root = this.roots[edit.location.root];
    let folder = root;
    for (const part of parent.slice(root.length).split('/').filter(Boolean)) {
      folder = join(folder, part);
      if (!existsSync(folder)) mkdirSync(folder, { mode: 0o755 });
      if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) throw new WorkspaceError('The parent folder changed.');
    }
    this.location(edit.location);
    const temp = join(parent, `.browsentic-edit-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temp, 'wx', 0o600);
      writeFileSync(descriptor, edit.newText); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      chmodSync(temp, mode); renameSync(temp, file);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temp); } catch { /* renamed successfully, or never created */ }
    }
    return { path: edit.location.path, root: edit.location.root, sha256: digest(edit.newText), written: true };
  }
}

function protectedName(name: string): boolean {
  return BLOCKED_PARTS.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /^(?:auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|\.npmrc)$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

export async function projectWorkspace(projectId: string, threadId?: string | null): Promise<WorkspaceFiles> {
  if (!validCodexThreadId(projectId)) throw new WorkspaceError('Invalid selected project.');
  const project = (await savedCodexProjects()).find((item) => item.id === projectId);
  if (!project) throw new WorkspaceError('Select an existing local Codex project.');
  if (threadId) {
    const result = await codexHistory({ threadId });
    if (!result.ok || result.data.thread?.projectId !== projectId) throw new WorkspaceError('This conversation belongs to a different project.');
    const cwd = result.data.thread.cwd;
    if (cwd && allowedWorkspaceCwd(project.roots, cwd)) project.roots = [cwd, ...project.roots.filter((root) => root !== cwd)];
  }
  return new WorkspaceFiles(project);
}

function within(path: string, root: string): boolean {
  const tail = relative(root, path);
  return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith('../') && !tail.startsWith('..\\');
}

/** Preserve a chat's working copy only when it belongs to a saved root or its matching Git worktree. */
export function allowedWorkspaceCwd(roots: string[], cwd: string): boolean {
  try {
    const candidate = realpathSync(cwd);
    for (const root of roots) {
      const canonical = realpathSync(root);
      if (within(candidate, canonical)) return true;
      const selected = gitLocation(canonical);
      const working = gitLocation(candidate);
      if (selected && working && selected.common === working.common && within(working.subdir || '.', selected.subdir || '.')) return true;
    }
  } catch { /* unavailable or unverified: keep the saved project roots */ }
  return false;
}

function gitLocation(folder: string): { common: string; subdir: string } | null {
  const original = folder;
  for (let level = 0; level < 20; level++) {
    const marker = join(folder, '.git');
    if (existsSync(marker)) {
      const stat = lstatSync(marker);
      if (stat.isSymbolicLink()) return null;
      let git = marker;
      if (stat.isFile()) {
        if (stat.size > 4096) return null;
        const match = /^gitdir: ([^\r\n]+)\s*$/.exec(readFileSync(marker, 'utf8'));
        if (!match) return null;
        git = resolve(folder, match[1]);
      } else if (!stat.isDirectory()) return null;
      const shared = join(git, 'commondir');
      let common = realpathSync(git);
      if (existsSync(shared)) {
        const info = lstatSync(shared);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
        common = realpathSync(resolve(git, readFileSync(shared, 'utf8').trim()));
      }
      return { common, subdir: relative(folder, original) };
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}
