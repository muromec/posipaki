// ── Who a message that crossed the wire came from ──────────────────────────
//
// A frame carries its sender as a name, because a symbol cannot be written down.
// On the other side the name is turned back into an identity a process can be
// handed: whoever the frame names, and — when that name is the one a process was
// told is its parent — the parent's own stable id, so a child on either side of
// the seam recognises the same sender.

import type { SenderInfo } from "../types.js";

export function makeSender(
  fromName: string,
  parentName: string | null,
  parentId: symbol | null,
): SenderInfo {
  if (parentId && fromName === parentName) {
    return { fromName, fromId: parentId };
  }
  return { fromName, fromId: Symbol() };
}
