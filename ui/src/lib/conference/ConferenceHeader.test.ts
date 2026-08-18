import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import ConferenceHeader from "./ConferenceHeader.svelte";

describe("ConferenceHeader", () => {
  it("shows the title, or 'Call' when empty", async () => {
    const { rerender } = render(ConferenceHeader, { title: "Aylin Ruiz" });
    expect(screen.getByText("Aylin Ruiz")).toBeInTheDocument();

    await rerender({ title: "" });
    expect(screen.getByText("Call")).toBeInTheDocument();
  });

  it("formats duration as mm:ss under an hour", () => {
    render(ConferenceHeader, { callDurationSeconds: 42, participantCount: 2 });
    expect(screen.getByText("00:42 · 2 people")).toBeInTheDocument();
  });

  it("formats duration as hh:mm:ss past an hour", () => {
    render(ConferenceHeader, { callDurationSeconds: 3903, participantCount: 3 });
    expect(screen.getByText("01:05:03 · 3 people")).toBeInTheDocument();
  });

  it("singularises the participant label for one person", () => {
    render(ConferenceHeader, { callDurationSeconds: 0, participantCount: 1 });
    expect(screen.getByText("00:00 · 1 person")).toBeInTheDocument();
  });

  it("shows the status instead of the duration when one is set", () => {
    render(ConferenceHeader, { status: "Ringing", callDurationSeconds: 99, participantCount: 2 });
    expect(screen.getByText("Ringing")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("labels the toggle 'Speaker' in grid view and 'Grid' otherwise", async () => {
    const { rerender } = render(ConferenceHeader, { isGridView: true });
    expect(screen.getByText("Speaker")).toBeInTheDocument();

    await rerender({ isGridView: false });
    expect(screen.getByText("Grid")).toBeInTheDocument();
  });

  it("dispatches toggleView and minimize", async () => {
    const { component } = render(ConferenceHeader, { isGridView: true });
    const onToggle = vi.fn();
    const onMinimize = vi.fn();
    component.$on("toggleView", onToggle);
    component.$on("minimize", onMinimize);

    await fireEvent.click(screen.getByText("Speaker"));
    await fireEvent.click(screen.getByLabelText("common.conference_minimize"));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onMinimize).toHaveBeenCalledOnce();
  });
});
