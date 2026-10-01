import type { Locator, Page } from "playwright-core";
import type { FillAction } from "@ai-career/browser";

export type AttachmentPaths = Partial<Record<"resume" | "cover_letter", string>>;

const ACTION_TIMEOUT_MS = 5_000;
const KEY = /^f\d+$/;
const FORBIDDEN_INPUT_TYPES = new Set(["submit", "button", "image", "reset"]);
const NON_TEXT_INPUT_TYPES = new Set(["radio", "checkbox", "file", "hidden", "submit", "button", "image", "reset"]);

/** Thrown when an action targets anything but the expected kind of form control. Carries no page content. */
export class GuardViolation extends Error {
  constructor() {
    super("guard_violation");
    this.name = "GuardViolation";
  }
}

const byKey = (page: Page, key: string): Locator => {
  if (!KEY.test(key)) throw new GuardViolation();
  return page.locator(`[data-cp-key="${key}"]`);
};

type Allowed = "text" | "select" | "choice" | "file";

/**
 * The stop-before-submit guard (design §5, DECISIONS D130). Every mutation goes through here: the element must be
 * the expected control kind, and is never a button, link or submit/image/reset input. `check` (which Playwright
 * performs as a click on the input itself) is therefore only ever applied to a radio or checkbox input.
 */
async function assertTarget(loc: Locator, allowed: Allowed): Promise<void> {
  const { tag, type } = await loc.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") ?? "text").toLowerCase() }));
  if (tag === "button" || tag === "a" || (tag === "input" && FORBIDDEN_INPUT_TYPES.has(type))) throw new GuardViolation();
  const ok =
    allowed === "select" ? tag === "select"
    : allowed === "choice" ? tag === "input" && (type === "radio" || type === "checkbox")
    : allowed === "file" ? tag === "input" && type === "file"
    : tag === "textarea" || (tag === "input" && !NON_TEXT_INPUT_TYPES.has(type));
  if (!ok) throw new GuardViolation();
}

export async function performAction(page: Page, action: FillAction, files: AttachmentPaths): Promise<void> {
  const loc = byKey(page, action.targetKey);
  switch (action.kind) {
    case "fill":
      await assertTarget(loc, "text");
      await loc.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
      return;
    case "selectOption":
      await assertTarget(loc, "select");
      await loc.selectOption({ value: action.optionValue }, { timeout: ACTION_TIMEOUT_MS });
      return;
    case "check":
      await assertTarget(loc, "choice");
      await loc.check({ timeout: ACTION_TIMEOUT_MS });
      return;
    case "setInputFiles": {
      await assertTarget(loc, "file");
      const file = files[action.file];
      if (!file) throw new Error("attachment_missing");
      await loc.setInputFiles(file, { timeout: ACTION_TIMEOUT_MS });
      return;
    }
  }
}

/** Reads the control back. Any error (element gone, detached) counts as not verified. */
export async function verifyAction(page: Page, action: FillAction): Promise<boolean> {
  try {
    const loc = byKey(page, action.targetKey);
    switch (action.kind) {
      case "fill":
        return (await loc.inputValue({ timeout: ACTION_TIMEOUT_MS })) === action.text;
      case "selectOption":
        return (await loc.inputValue({ timeout: ACTION_TIMEOUT_MS })) === action.optionValue;
      case "check":
        return await loc.isChecked({ timeout: ACTION_TIMEOUT_MS });
      case "setInputFiles":
        return (await loc.evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)) > 0;
    }
  } catch {
    return false;
  }
}
