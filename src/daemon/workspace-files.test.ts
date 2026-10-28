import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { stateDir } from './lockfile';
import { WorkspaceFiles, allowedWorkspaceCwd } from './workspace-files';

let workspace: WorkspaceFiles;
let root: string;
beforeEach(() => {
  root = join(stateDir, 'project');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'code.ts'), 'one\ntwo\nthree\n');
  workspace = new WorkspaceFiles({ id: 'test', name: 'Test project', roots: [root] });
});

describe('project filesystem confinement', () => {
  test('reads numbered lines and a revision, and lists the selected root', () => {
    expect(workspace.read({ path: 'code.ts', startLine: 2, limit: 1 })).toMatchObject({ path: 'code.ts', lineCount: 4, content: '2: two' });
    expect(workspace.read({ path: 'code.ts' }).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(workspace.list({}).entries.some((entry) => entry.name === 'code.ts')).toBe(true);
  });
  test('rejects parent traversal, absolute paths, malformed roots and credential/config files', () => {
    for (const path of ['../outside', 'x/../../outside', '/etc/passwd', 'C:\\Windows', '.git/config', '.GIT/config', '.git./config', 'dir /file', '.codex/config.toml', '.env', '.env.local', '.ssh/id_rsa', 'auth.json', 'key.pem', 'x\0y', 'x//y']) {
      expect(() => workspace.read({ path })).toThrow();
    }
    for (const root of [-1, 1, 0.5, '0', {}, null]) {
      if (root === null) continue;
      expect(() => workspace.read({ path: 'code.ts', root })).toThrow();
    }
  });
  test('a project root replaced by an outside symlink is not followed', () => {
    const moved = root + '-old'; rmSync(moved, { recursive: true, force: true });
    renameSync(root, moved); symlinkSync(stateDir, root);
    expect(() => workspace.list({})).toThrow('project folder changed');
  });
  test('native chat cwd cannot add an unrelated folder to the project scope', () => {
    expect(allowedWorkspaceCwd([root], root)).toBe(true);
    expect(allowedWorkspaceCwd([root], stateDir)).toBe(false);
    expect(allowedWorkspaceCwd([root], '/etc')).toBe(false);
  });
  test('a matching Git worktree is recognized without executing Git or a repository hook', () => {
    const common = join(root, '.git'); mkdirSync(common, { recursive: true });
    const git = join(common, 'worktrees', 'test'); mkdirSync(git, { recursive: true });
    writeFileSync(join(git, 'commondir'), '../..\n');
    const worktree = join(stateDir, 'other-working-copy'); mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${git}\n`);
    expect(allowedWorkspaceCwd([root], worktree)).toBe(true);
    const subproject = join(root, 'app'); mkdirSync(subproject, { recursive: true });
    const otherApp = join(worktree, 'different-app'); mkdirSync(otherApp, { recursive: true });
    expect(allowedWorkspaceCwd([subproject], otherApp)).toBe(false);
  });
  test('rejects symlinks to outside files, folders, and dangling targets', () => {
    const outside = join(stateDir, 'outside.txt'); writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(stateDir, join(root, 'linked-dir'));
    symlinkSync(join(stateDir, 'missing'), join(root, 'dangling'));
    for (const path of ['escape', 'linked-dir/outside.txt', 'dangling']) expect(() => workspace.read({ path })).toThrow('Symlinks');
    expect(workspace.list({}).entries.some((entry) => entry.name === 'escape')).toBe(false);
    expect(() => workspace.prepare({ path: 'dangling', sha256: 'new', startLine: 1, endLine: 0, text: 'bad' })).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });
  test('refuses binary, malformed UTF-8 and oversized files', () => {
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, 'invalid-utf8'), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(root, 'large'), 'x'.repeat(1024 * 1024 + 1));
    for (const path of ['binary', 'invalid-utf8', 'large']) expect(() => workspace.read({ path })).toThrow();
    expect(() => workspace.read({ path: 'code.ts', limit: 501 })).toThrow('line range');
  });
});

describe('revision-bound project edits', () => {
  const edit = (text: string) => workspace.prepare({ path: 'code.ts', sha256: workspace.read({ path: 'code.ts' }).sha256, startLine: 2, endLine: 2, text });
  test('preparing a preview does not write; applying changes only the approved line', () => {
    const patch = edit('updated');
    expect(patch.preview).toMatchObject({ path: 'code.ts', before: 'two', after: 'updated' });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(workspace.apply(patch)).toMatchObject({ written: true });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('one\nupdated\nthree\n');
  });
  test('a concurrent user edit invalidates the pending approval', () => {
    const patch = edit('updated');
    writeFileSync(join(root, 'code.ts'), 'user edit');
    expect(() => workspace.apply(patch)).toThrow('changed while approval');
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('user edit');
  });
  test('a file replaced with an outside symlink while approval is pending is refused', () => {
    const patch = edit('updated');
    const outside = join(stateDir, 'other.txt'); writeFileSync(outside, 'outside');
    unlinkSync(join(root, 'code.ts')); symlinkSync(outside, join(root, 'code.ts'));
    expect(() => workspace.apply(patch)).toThrow('Symlinks');
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });
  test('can create a nested file after approval without overwriting a newly appeared file', () => {
    const patch = workspace.prepare({ path: 'src/new.ts', sha256: 'new', startLine: 1, endLine: 0, text: 'created\n' });
    expect(existsSync(join(root, 'src'))).toBe(false);
    workspace.apply(patch);
    expect(readFileSync(join(root, 'src/new.ts'), 'utf8')).toBe('created\n');
    const other = workspace.prepare({ path: 'another.ts', sha256: 'new', startLine: 1, endLine: 0, text: 'created' });
    writeFileSync(join(root, 'another.ts'), 'user file');
    expect(() => workspace.apply(other)).toThrow('changed while approval');
  });
  test('supports insertion and deletion without changing the rest of the file', () => {
    workspace.apply(workspace.prepare({ path: 'code.ts', sha256: workspace.read({ path: 'code.ts' }).sha256, startLine: 2, endLine: 1, text: 'inserted' }));
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('one\ninserted\ntwo\nthree\n');
    workspace.apply(workspace.prepare({ path: 'code.ts', sha256: workspace.read({ path: 'code.ts' }).sha256, startLine: 2, endLine: 2, text: '' }));
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
  });
  test('preserves CRLF line endings outside and inside the approved replacement', () => {
    writeFileSync(join(root, 'code.ts'), 'one\r\ntwo\r\nthree\r\n');
    workspace.apply(edit('updated'));
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('one\r\nupdated\r\nthree\r\n');
  });
  test('refuses stale hashes, invalid ranges, oversized patches, and credential changes', () => {
    const sha256 = workspace.read({ path: 'code.ts' }).sha256;
    for (const patch of [
      { sha256: '0'.repeat(64) }, { startLine: 0 }, { endLine: 100 }, { startLine: 3, endLine: 1 }, { text: 'x'.repeat(128 * 1024 + 1) }, { text: 'api_key: sk-proj-' + 'A'.repeat(72) },
    ]) expect(() => workspace.prepare({ path: 'code.ts', sha256, startLine: 1, endLine: 1, text: 'new', ...patch })).toThrow();
  });
});
