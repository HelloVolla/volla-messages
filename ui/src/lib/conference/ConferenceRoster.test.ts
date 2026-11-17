import { render, screen } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";

// Avatar pulls Holochain profile stores off Svelte context; the roster's own logic doesn't need
// it, so stub it out with a marker element.
vi.mock("$lib/Avatar.svelte", async () => {
  const Stub = (await import("./AvatarStub.svelte")).default;
  return { default: Stub };
});

import ConferenceRoster from "./ConferenceRoster.svelte";
import type { ParticipantData } from "./types";

function participant(over: Partial<ParticipantData> & { pubKey: string }): ParticipantData {
  return {
    publicKey: over.pubKey,
    isLocal: false,
    hasJoined: false,
    connectionStatus: "idle",
    _connected: false,
    _stream: null,
    ...over,
  } as ParticipantData;
}

const names: Record<string, string> = { a: "Aylin", m: "Mira", j: "Jonas" };
const getName = (k: string) => names[k] ?? k;

describe("ConferenceRoster — single participant", () => {
  it("shows the name and a Ringing status while waiting", () => {
    render(ConferenceRoster, { participants: [participant({ pubKey: "a" })], getName });
    expect(screen.getByText("Aylin")).toBeInTheDocument();
    expect(screen.getByText("Ringing")).toBeInTheDocument();
  });

  it("shows Connecting when the connecting flag is set", () => {
    render(ConferenceRoster, {
      participants: [participant({ pubKey: "a" })],
      getName,
      connecting: true,
    });
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.queryByText("Ringing")).toBeNull();
  });

  it("shows Joined once the participant has connected", () => {
    render(ConferenceRoster, {
      participants: [participant({ pubKey: "a", hasJoined: true, _connected: true })],
      getName,
    });
    expect(screen.getByText("Joined")).toBeInTheDocument();
  });

  it("shows Declined for a declined participant", () => {
    render(ConferenceRoster, {
      participants: [participant({ pubKey: "a", declined: true })],
      getName,
    });
    expect(screen.getByText("Declined")).toBeInTheDocument();
  });
});

describe("ConferenceRoster — group", () => {
  it("summarises joined and ringing counts and keeps declined visible", () => {
    render(ConferenceRoster, {
      getName,
      participants: [
        participant({ pubKey: "a", hasJoined: true, _connected: true }),
        participant({ pubKey: "m" }),
        participant({ pubKey: "j", declined: true }),
      ],
    });

    expect(screen.getByText("Group call")).toBeInTheDocument();
    expect(screen.getByText("1 joined · 1 ringing")).toBeInTheDocument();
    // Declined participants stay in the list rather than being dropped.
    expect(screen.getByText("Jonas")).toBeInTheDocument();
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText("Joined")).toBeInTheDocument();
    expect(screen.getByText("Ringing")).toBeInTheDocument();
  });
});
