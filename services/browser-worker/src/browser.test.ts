import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchBrowser, removeStaleSessionDirs, ReleasedWindows, SESSION_DIR_PREFIX, type BrowserHandle } from "./browser";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roots: string[] = [];
const handles: BrowserHandle[] = [];

async function freshHandle(): Promise<BrowserHandle> {
  const root = await mkdtemp(path.join(tmpdir(), "cp-browser-test-"));
  roots.push(root);
  const handle = await launchBrowser({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, rootDir: path.join(root, "session") });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }).catch(() => undefined)));
});

describe("launchBrowser close()", () => {
  it("removes rootDir and a second close() does not throw", async () => {
    const handle = await freshHandle();
    expect(existsSync(handle.rootDir)).toBe(true);
    await handle.close();
    expect(existsSync(handle.rootDir)).toBe(false);
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

describe("ReleasedWindows", () => {
  it("replaces an earlier deadline instead of stacking it: size stays 1 and the shorter deadline wins", async () => {
    const handle = await freshHandle();
    const released = new ReleasedWindows();
    released.release(handle, 60_000);
    released.release(handle, 50);
    expect(released.size).toBe(1);
    await wait(500);
    expect(handle.isClosed()).toBe(true);
    expect(released.size).toBe(0);
  });

  it("closeAll closes every released window and empties the registry", async () => {
    const a = await freshHandle();
    const b = await freshHandle();
    const released = new ReleasedWindows();
    released.release(a, 60_000);
    released.release(b, 60_000);
    expect(released.size).toBe(2);
    await released.closeAll();
    expect(a.isClosed()).toBe(true);
    expect(b.isClosed()).toBe(true);
    expect(released.size).toBe(0);
  });

  it("removes a window from the registry when its context is closed directly", async () => {
    const handle = await freshHandle();
    const released = new ReleasedWindows();
    released.release(handle, 60_000);
    expect(released.size).toBe(1);
    await handle.context.close();
    await wait(100);
    expect(released.size).toBe(0);
  });

  it("setActive + closeAll closes the active (in-progress) window even though it was never released", async () => {
    const handle = await freshHandle();
    const released = new ReleasedWindows();
    released.setActive(handle);
    expect(released.size).toBe(0); // active is not a released/timed window
    await released.closeAll();
    expect(handle.isClosed()).toBe(true);
  });

  it("setActive is cleared by release(): closeAll then closes it via the normal timed path, not twice", async () => {
    const handle = await freshHandle();
    const released = new ReleasedWindows();
    released.setActive(handle);
    released.release(handle, 60_000);
    expect(released.size).toBe(1);
    await released.closeAll();
    expect(handle.isClosed()).toBe(true);
    expect(released.size).toBe(0);
  });
});

describe("removeStaleSessionDirs", () => {
  it("removes only directories matching the session prefix, under the given root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cp-stale-scan-"));
    roots.push(root);
    const stale1 = path.join(root, `${SESSION_DIR_PREFIX}aaaaaa`);
    const stale2 = path.join(root, `${SESSION_DIR_PREFIX}bbbbbb`);
    const unrelated = path.join(root, "some-other-dir");
    await mkdir(stale1, { recursive: true });
    await mkdir(stale2, { recursive: true });
    await mkdir(unrelated, { recursive: true });

    const removed = await removeStaleSessionDirs(root);

    expect(removed).toBe(2);
    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("returns 0 for a root that does not exist, without throwing", async () => {
    await expect(removeStaleSessionDirs(path.join(tmpdir(), "cp-does-not-exist-xyz"))).resolves.toBe(0);
  });
});
