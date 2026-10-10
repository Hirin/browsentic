import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { WAITING_UPDATE_KEY, asWaitingVersion, followBridge, serveExtensionUpdates } from './extension-update';

const RUNNING = '0.8.2';

let installType: string;
let onDisk: string;
const checkForUpdate = vi.fn();

const waiting = async () => (await fakeBrowser.storage.session.get(WAITING_UPDATE_KEY))[WAITING_UPDATE_KEY];

beforeEach(() => {
  fakeBrowser.reset();
  installType = 'normal';
  onDisk = RUNNING;
  checkForUpdate.mockReset().mockResolvedValue({ status: 'no_update' });
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: RUNNING } as never);
  vi.spyOn(fakeBrowser.runtime, 'requestUpdateCheck').mockImplementation(checkForUpdate);
  vi.spyOn(fakeBrowser.management, 'getSelf').mockImplementation(async () => ({ installType }) as never);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: onDisk })));
});

describe('an update the browser has downloaded', () => {
  it('is held for the panel instead of waiting for the extension to go idle', async () => {
    serveExtensionUpdates();
    await fakeBrowser.runtime.onUpdateAvailable.trigger({ version: '0.8.3' });
    await vi.waitFor(async () => expect(await waiting()).toBe('0.8.3'));
  });

  it('stops being offered once the extension runs it, or anything newer', () => {
    expect([asWaitingVersion('0.8.3'), asWaitingVersion('0.8.2'), asWaitingVersion('0.8.1'), asWaitingVersion(undefined)]).toEqual([
      '0.8.3',
      null,
      null,
      null,
    ]);
  });
});

describe('a store copy following a newer Bridge', () => {
  it('asks the store as soon as the Bridge says it is newer', async () => {
    await followBridge('0.8.3');
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('spends the browser’s one check in a few hours only once for each Bridge version', async () => {
    await followBridge('0.8.3');
    await followBridge('0.8.3');
    await followBridge('0.8.4');
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('leaves the store alone while the Bridge is the same version or older', async () => {
    await followBridge('0.8.2');
    await followBridge('0.8.1');
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('survives a browser that will not check at all', async () => {
    checkForUpdate.mockRejectedValue(new Error('updates disabled'));
    await expect(followBridge('0.8.3')).resolves.toBeUndefined();
  });
});

describe('an unpacked copy following a newer Bridge', () => {
  beforeEach(() => {
    installType = 'development';
  });

  it('offers a reload once the Bridge has rewritten its folder', async () => {
    onDisk = '0.8.3';
    await followBridge('0.8.3');
    expect([await waiting(), checkForUpdate.mock.calls.length]).toEqual(['0.8.3', 0]);
  });

  it('offers nothing while the folder still holds the running build', async () => {
    await followBridge('0.8.3');
    expect(await waiting()).toBeUndefined();
  });
});
