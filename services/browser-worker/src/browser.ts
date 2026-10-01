import type { Dirent } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export interface BrowserOptions {
  headless: boolean;
  executablePath?: string;
}

/** Shared by runSession's mkdtemp call and removeStaleSessionDirs' cleanup scan below. */
export const SESSION_DIR_PREFIX = "careerpilot-autofill-";

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  /** Holds the throwaway profile (profile/) and the attachments (files/). Deleted on close. */
  rootDir: string;
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * Design §5: a fresh persistent profile per session (no user cookies or logins), deleted with the attachments when
 * the window is closed. Attachments must outlive filling: Chrome reads an <input type=file> when the form is
 * submitted, which the user does later (D132).
 */
export async function launchBrowser(opts: BrowserOptions & { rootDir: string }): Promise<BrowserHandle> {
  const profileDir = path.join(opts.rootDir, "profile");
  await mkdir(profileDir, { recursive: true });
  const removeRoot = () => rm(opts.rootDir, { recursive: true, force: true }).catch(() => undefined);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...(opts.executablePath ? { executablePath: opts.executablePath } : { channel: "chrome" }),
      headless: opts.headless,
      viewport: null,
      acceptDownloads: false,
    });
  } catch (error) {
    await removeRoot();
    throw error;
  }
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    rootDir: opts.rootDir,
    isClosed: () => closed || context.pages().length === 0,
    close: async () => {
      if (!closed) await context.close().catch(() => undefined);
      closed = true;
      await removeRoot();
    },
  };
}

/**
 * Windows handed to the user after the job returns (needs_manual, submission_detected -- spec §11.6), plus the
 * one window a session currently in progress (launching/filling/awaiting_user) has open. Each released window is
 * closed at its deadline, when the user closes it, or on worker shutdown; the in-progress window has no deadline
 * of its own, but shutdown must still close it so its temp profile/attachments are not leaked (spec §5).
 */
export class ReleasedWindows {
  private readonly timers = new Map<BrowserHandle, NodeJS.Timeout>();
  private active: BrowserHandle | null = null;

  /** runSession calls this right after launch and clears it (pass null) in its finally, win or lose. */
  setActive(handle: BrowserHandle | null): void {
    this.active = handle;
  }

  release(handle: BrowserHandle, ms: number): void {
    if (this.active === handle) this.active = null;
    const alreadyTracked = this.timers.has(handle);
    const existing = this.timers.get(handle);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.closeOne(handle), Math.max(0, ms));
    this.timers.set(handle, timer);
    // Register the close listener only the first time: a second release() for the same handle must
    // replace the deadline, not add another listener that would double-invoke closeOne.
    if (!alreadyTracked) handle.context.on("close", () => void this.closeOne(handle));
  }

  private async closeOne(handle: BrowserHandle): Promise<void> {
    const timer = this.timers.get(handle);
    if (timer) clearTimeout(timer);
    this.timers.delete(handle);
    if (this.active === handle) this.active = null;
    await handle.close();
  }

  async closeAll(): Promise<void> {
    const targets = new Set(this.timers.keys());
    if (this.active) targets.add(this.active);
    await Promise.all([...targets].map((h) => this.closeOne(h)));
  }

  get size(): number {
    return this.timers.size;
  }
}

/**
 * Startup cleanup (spec §5): a worker that is killed or crashes mid-session leaves its throwaway profile and
 * downloaded attachments behind in the OS temp dir. Single-worker assumption: only one browser-worker process is
 * ever expected to run against a given tmp root, so every careerpilot-autofill-* directory found at startup
 * belongs to a previous process that is no longer running and is safe to remove. Returns how many were removed.
 */
export async function removeStaleSessionDirs(tmpRoot: string = tmpdir()): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const stale = entries.filter((e) => e.isDirectory() && e.name.startsWith(SESSION_DIR_PREFIX));
  await Promise.all(stale.map((e) => rm(path.join(tmpRoot, e.name), { recursive: true, force: true }).catch(() => undefined)));
  return stale.length;
}
