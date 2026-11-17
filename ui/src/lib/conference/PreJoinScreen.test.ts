import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import PreJoinScreen from "./PreJoinScreen.svelte";

describe("PreJoinScreen", () => {
  it("shows the caller name and a single-caller subtitle", () => {
    render(PreJoinScreen, { callerName: "Aylin", participantCount: 2 });
    expect(screen.getByText("Aylin")).toBeInTheDocument();
    expect(screen.getByText("is calling")).toBeInTheDocument();
  });

  it("falls back to Unknown when no caller name is given", () => {
    render(PreJoinScreen, { callerName: "" });
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("shows a people count for group calls", () => {
    render(PreJoinScreen, { callerName: "Aylin", participantCount: 4 });
    expect(screen.getByText("is calling · 4 people")).toBeInTheDocument();
  });

  it("defaults to mic on and camera off", () => {
    render(PreJoinScreen, { callerName: "Aylin" });
    expect(screen.getByText("Mic on")).toBeInTheDocument();
    expect(screen.getByText("Camera off")).toBeInTheDocument();
  });

  it("dispatches join with the current media flags", async () => {
    const { component } = render(PreJoinScreen, { callerName: "Aylin" });
    const onJoin = vi.fn();
    component.$on("join", (e) => onJoin(e.detail));

    await fireEvent.click(screen.getByText("Accept"));

    expect(onJoin).toHaveBeenCalledWith({ videoEnabled: false, audioEnabled: true });
  });

  it("toggling the mic chip flips the flag and emits media", async () => {
    const { component } = render(PreJoinScreen, { callerName: "Aylin" });
    const onMedia = vi.fn();
    component.$on("media", (e) => onMedia(e.detail));

    await fireEvent.click(screen.getByText("Mic on"));

    expect(screen.getByText("Mic off")).toBeInTheDocument();
    expect(onMedia).toHaveBeenLastCalledWith({ videoEnabled: false, audioEnabled: false });
  });

  it("toggling the camera chip flips the flag and emits media", async () => {
    const { component } = render(PreJoinScreen, { callerName: "Aylin" });
    const onMedia = vi.fn();
    component.$on("media", (e) => onMedia(e.detail));

    await fireEvent.click(screen.getByText("Camera off"));

    expect(screen.getByText("Camera on")).toBeInTheDocument();
    expect(onMedia).toHaveBeenLastCalledWith({ videoEnabled: true, audioEnabled: true });
  });

  it("dispatches cancel when the ✕ is pressed", async () => {
    const { component } = render(PreJoinScreen, { callerName: "Aylin" });
    const onCancel = vi.fn();
    component.$on("cancel", onCancel);

    await fireEvent.click(screen.getByLabelText("Cancel"));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders the preview video only when the camera is on and a stream is present", async () => {
    const { container } = render(PreJoinScreen, {
      callerName: "Aylin",
      localStream: {} as MediaStream,
    });
    expect(container.querySelector("video")).toBeNull();

    await fireEvent.click(screen.getByText("Camera off"));

    expect(container.querySelector("video")).not.toBeNull();
  });
});
