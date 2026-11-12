import { expect, test } from "bun:test";
import { canInstall } from "./device";

test("canInstall: only where navigator.install exists and the page is not already the installed app", () => {
  expect(canInstall({ install: () => Promise.resolve() }, false)).toBe(true);
  expect(canInstall({ install: () => Promise.resolve() }, true)).toBe(false);
  expect(canInstall({}, false)).toBe(false);
  expect(canInstall({ install: "yes" }, false)).toBe(false);
});
