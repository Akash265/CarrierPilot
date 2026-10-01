import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export interface BrowserOptions {
  headless: boolean;
  executablePath?: string;
}

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
 * Windows handed to the user after the job returns (needs_manual, submission_detected -- spec §11.6). Each is
 * closed at its deadline, when the user closes it, or on worker shutdown, so the queue is never blocked by one.
 */
export class ReleasedWindows {
  private readonly timers = new Map<BrowserHandle, NodeJS.Timeout>();

  release(handle: BrowserHandle, ms: number): void {
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
    await handle.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.timers.keys()].map((h) => this.closeOne(h)));
  }

  get size(): number {
    return this.timers.size;
  }
}
