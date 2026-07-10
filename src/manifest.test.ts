import { describe, expect, test } from "vitest";
import manifest from "./manifest.js";

describe("plugin UI launcher manifest", () => {
  test("global Chat launcher targets the page export the host modal resolver loads", () => {
    const pageSlot = manifest.ui?.slots?.find((slot) => slot.id === "chat-page");
    const launcher = manifest.ui?.launchers?.find((entry) => entry.id === "chat-orchestrator-modal");

    expect(pageSlot?.type).toBe("page");
    expect(pageSlot?.exportName).toBe("ChatPage");
    expect(launcher?.placementZone).toBe("globalToolbarButton");
    expect(launcher?.action.type).toBe("openModal");
    expect(launcher?.action.target).toBe(pageSlot?.exportName);
  });
});
