import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { greenhouseV1, type FillAction } from "@ai-career/browser";
import { launchBrowser, type BrowserHandle } from "./browser";
import { performAction, verifyAction, GuardViolation } from "./actions";
import { takeSnapshot } from "./snapshot";

const HTML = `<!doctype html><html><body><form id="application-form">
  <label for="first_name">First Name*</label><input id="first_name" type="text">
  <select id="pick"><option value="">Select</option><option value="1">Yes</option><option value="0">No</option></select>
  <label><input type="radio" name="sp" value="Yes">Yes</label><label><input type="radio" name="sp" value="No">No</label>
  <input id="resume" type="file">
  <button id="go" type="submit">Submit</button><a id="link" href="#">Link</a><input id="sub" type="submit" value="Send">
</form></body></html>`;

let root: string;
let handle: BrowserHandle;
let pdf: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cp-actions-test-"));
  pdf = path.join(root, "resume.pdf");
  await writeFile(pdf, "%PDF-1.4 test");
  handle = await launchBrowser({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, rootDir: path.join(root, "session") });
  await handle.page.setContent(HTML);
  await takeSnapshot(handle.page, greenhouseV1); // stamps data-cp-key: f0 text, f1 select, g2 radio group (f3, f4), f5 file
});
afterAll(async () => {
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

const stamp = (selector: string, key: string) =>
  handle.page.evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute("data-cp-key", ${JSON.stringify(key)})`);

describe("guarded actions in real Chrome", () => {
  it("fills, selects, checks and attaches, and verifies each", async () => {
    const actions: FillAction[] = [
      { kind: "fill", fieldKey: "f0", targetKey: "f0", text: "Jane" },
      { kind: "selectOption", fieldKey: "f1", targetKey: "f1", optionValue: "0" },
      { kind: "check", fieldKey: "g2", targetKey: "f4" },
      { kind: "setInputFiles", fieldKey: "f5", targetKey: "f5", file: "resume" },
    ];
    for (const action of actions) {
      await performAction(handle.page, action, { resume: pdf });
      expect(await verifyAction(handle.page, action)).toBe(true);
    }
    expect(await handle.page.inputValue("#first_name")).toBe("Jane");
  });

  it("refuses to act on buttons, links and submit inputs", async () => {
    await stamp("#go", "f90");
    await stamp("#link", "f91");
    await stamp("#sub", "f92");
    for (const key of ["f90", "f91", "f92"]) {
      await expect(performAction(handle.page, { kind: "fill", fieldKey: key, targetKey: key, text: "x" }, {})).rejects.toBeInstanceOf(GuardViolation);
      await expect(performAction(handle.page, { kind: "check", fieldKey: key, targetKey: key }, {})).rejects.toBeInstanceOf(GuardViolation);
    }
  });

  it("refuses a mismatched control kind and malformed keys", async () => {
    await expect(performAction(handle.page, { kind: "check", fieldKey: "f0", targetKey: "f0" }, {})).rejects.toBeInstanceOf(GuardViolation);
    await expect(performAction(handle.page, { kind: "fill", fieldKey: "x", targetKey: '"] , button[id="go', text: "x" }, {})).rejects.toBeInstanceOf(GuardViolation);
  });

  it("reports a failed verification as false rather than throwing", async () => {
    expect(await verifyAction(handle.page, { kind: "fill", fieldKey: "f0", targetKey: "f0", text: "Someone else" })).toBe(false);
    expect(await verifyAction(handle.page, { kind: "fill", fieldKey: "f999", targetKey: "f999", text: "x" })).toBe(false);
  });
});
