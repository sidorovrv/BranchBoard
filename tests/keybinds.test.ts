import { describe, expect, it } from "vitest";
import { combinedPanDirection, isTextAttachment, panDirectionOf, bindingProblem, boundActionId, clickBindingOf, isDefaultBinding, isHoldActive, isSidePointerButton, keyBindingOf, normaliseKeybinds, shortcutLabelOf, sharedBindingOwners } from "../packages/core/src";

const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("keybinds", () => {
  it("names a key press by modifiers in a fixed order", () => {
    expect(keyBindingOf({ ...none, ctrlKey: true, shiftKey: true, key: "z", code: "KeyZ" })).toBe("Ctrl+Shift+Z");
    expect(keyBindingOf({ ...none, metaKey: true, key: "k", code: "KeyK" })).toBe("Ctrl+K");
  });

  it("uses the physical letter so other keyboard layouts match", () => {
    expect(keyBindingOf({ ...none, altKey: true, key: "т", code: "KeyN" })).toBe("Alt+N");
  });

  it("ignores a bare modifier press and names space and plus", () => {
    expect(keyBindingOf({ ...none, altKey: true, key: "Alt", code: "AltLeft" })).toBeUndefined();
    expect(keyBindingOf({ ...none, key: " ", code: "Space" })).toBe("Space");
    expect(keyBindingOf({ ...none, ctrlKey: true, key: "+" })).toBe("Ctrl+Plus");
  });

  it("names a click", () => {
    expect(clickBindingOf({ ...none, altKey: true, button: 0 })).toBe("Alt+Click");
    expect(clickBindingOf({ ...none, altKey: true, shiftKey: true, button: 0 })).toBe("Alt+Shift+Click");
  });

  it("names the middle and side mouse buttons with or without modifiers, and ignores the right one", () => {
    expect(clickBindingOf({ ...none, button: 3 })).toBe("Mouse4");
    expect(clickBindingOf({ ...none, button: 4 })).toBe("Mouse5");
    expect(clickBindingOf({ ...none, ctrlKey: true, button: 1 })).toBe("Ctrl+MiddleClick");
    expect(clickBindingOf({ ...none, button: 2 })).toBeUndefined();
    expect(isSidePointerButton(3)).toBe(true);
    expect(isSidePointerButton(0)).toBe(false);
    expect(isSidePointerButton(2)).toBe(false);
  });

  it("accepts a bare mouse button for the zoom action and for key actions, but not a bare left click", () => {
    const keybinds = normaliseKeybinds({ focusNode: ["Mouse4", "Click"], undo: ["Mouse5", "Ctrl+Z", "Click"] });
    expect(keybinds.focusNode).toEqual(["Mouse4"]);
    expect(keybinds.undo).toEqual(["Mouse5", "Ctrl+Z"]);
    expect(boundActionId(keybinds, "Mouse4")).toBe("focusNode");
    expect(sharedBindingOwners({ ...keybinds, redo: [...keybinds.redo, "Mouse5"] }, "redo")).toEqual({ Mouse5: ["Undo"] });
  });

  it("allows a key with no modifier", () => {
    expect(normaliseKeybinds({ reader: ["F2"] }).reader).toEqual(["F2"]);
    expect(bindingProblem(normaliseKeybinds({}), "reader", "F2")).toBeUndefined();
  });

  it("starts from the defaults, with two bindings for redo", () => {
    const keybinds = normaliseKeybinds(undefined);
    expect(keybinds.redo).toEqual(["Ctrl+Shift+Z", "Ctrl+Y"]);
    expect(keybinds.focusNode).toEqual(["Alt+Click"]);
    expect(sharedBindingOwners(keybinds, "redo")).toEqual({});
    expect(shortcutLabelOf(keybinds, "redo")).toBe("Ctrl+Shift+Z / Ctrl+Y");
  });

  it("keeps valid saved bindings, drops invalid ones and allows none", () => {
    const keybinds = normaliseKeybinds({ undo: ["Ctrl+Z", "Ctrl+Z", "Shift+Ctrl+Y", 4, "Alt+Click"], reader: [], focusNode: ["Click", "Ctrl+Alt+Click"], search: "Ctrl+K" });
    expect(keybinds.undo).toEqual(["Ctrl+Z"]);
    expect(keybinds.reader).toEqual([]);
    expect(keybinds.focusNode).toEqual(["Ctrl+Alt+Click"]);
    expect(keybinds.search).toEqual(["Ctrl+F"]);
    expect(isDefaultBinding(keybinds, "undo")).toBe(true);
    expect(isDefaultBinding(keybinds, "reader")).toBe(false);
  });

  it("finds the action a binding belongs to by kind", () => {
    const keybinds = normaliseKeybinds({});
    expect(boundActionId(keybinds, "Alt+N")).toBe("newChat");
    expect(boundActionId(keybinds, "Alt+Click")).toBe("focusNode");
    expect(boundActionId(keybinds, "Alt+Q")).toBeUndefined();
  });

  it("matches a held modifier combination exactly and keeps only valid hold bindings", () => {
    const keybinds = normaliseKeybinds({ alignGuides: ["Ctrl+Shift", "Shift+Ctrl", "Alt+Click", "X"] });
    expect(keybinds.alignGuides).toEqual(["Ctrl+Shift"]);
    expect(isHoldActive(keybinds, "alignGuides", { ...none, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isHoldActive(keybinds, "alignGuides", { ...none, ctrlKey: true })).toBe(false);
    expect(isHoldActive(normaliseKeybinds({}), "alignGuides", { ...none, altKey: true })).toBe(true);
    expect(isHoldActive(normaliseKeybinds({}), "alignGuides", none)).toBe(false);
  });

  it("refuses reserved and repeated bindings and reports bindings shared with other actions", () => {
    const keybinds = normaliseKeybinds({});
    expect(bindingProblem(keybinds, "undo", "Ctrl+C")).toContain("reserved");
    expect(bindingProblem(keybinds, "undo", "Alt+N")).toBeUndefined();
    expect(sharedBindingOwners({ ...keybinds, undo: ["Ctrl+Z", "Alt+N"] }, "undo")).toEqual({ "Alt+N": ["New chat node"] });
    expect(bindingProblem(keybinds, "newChat", "Alt+N")).toContain("already added");
    expect(bindingProblem(keybinds, "focusNode", "Shift+Click")).toContain("reserved");
    expect(bindingProblem(keybinds, "undo", "Alt+Q")).toBeUndefined();
  });
});

describe("keyboard panning", () => {
  it("maps keys by mode and normalises diagonals", () => {
    expect(panDirectionOf("wasd", "KeyW")).toEqual({ x: 0, y: -1 });
    expect(panDirectionOf("wasd", "ArrowUp")).toBeUndefined();
    expect(panDirectionOf("arrows", "ArrowLeft")).toEqual({ x: -1, y: 0 });
    expect(panDirectionOf("none", "KeyW")).toBeUndefined();
    const diagonal = combinedPanDirection("wasd", ["KeyW", "KeyD"]);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
    expect(combinedPanDirection("wasd", ["KeyA", "KeyD"])).toEqual({ x: 0, y: 0 });
  });

  it("recognises text attachments by name, type and size", () => {
    expect(isTextAttachment({ name: "a.ts", mime: "", size: 10 })).toBe(true);
    expect(isTextAttachment({ name: "a.bin", mime: "text/plain", size: 10 })).toBe(true);
    expect(isTextAttachment({ name: "a.pdf", mime: "application/pdf", size: 10 })).toBe(false);
    expect(isTextAttachment({ name: "big.ts", mime: "", size: 10_000_000 })).toBe(false);
  });
});
