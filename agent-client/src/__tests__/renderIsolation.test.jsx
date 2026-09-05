import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Profiler, useRef, useState } from "react";
import TranscriptLog from "../TranscriptLog.jsx";
import VolumeMeter from "../VolumeMeter.jsx";

// This is the test the v1 project didn't have: proof, not eyeballing a flamegraph, that a
// component downstream of the high-frequency volume value never re-renders because of it.
// React.Profiler's onRender only fires for a subtree that actually re-rendered in a commit — a
// memoized child that bails out produces no call at all, which is exactly the signal we want.
describe("render isolation", () => {
  it("does not re-render TranscriptLog when only the volume meter updates", () => {
    let renderCount = 0;

    function Harness() {
      const volumeRef = useRef(null);
      const [entries, setEntries] = useState([]);
      return (
        <div>
          <VolumeMeter ref={volumeRef} />
          <button
            data-testid="bump-volume"
            onClick={() => volumeRef.current?.setVolume(Math.random())}
          >
            bump volume
          </button>
          <button
            data-testid="add-message"
            onClick={() =>
              setEntries((prev) => [...prev, { id: String(prev.length), role: "agent", text: "hi" }])
            }
          >
            add message
          </button>
          <Profiler id="transcript" onRender={() => { renderCount += 1; }}>
            <TranscriptLog entries={entries} />
          </Profiler>
        </div>
      );
    }

    const { getByTestId } = render(<Harness />);
    expect(renderCount).toBe(1); // initial mount

    for (let i = 0; i < 20; i++) {
      fireEvent.click(getByTestId("bump-volume"));
    }
    expect(renderCount).toBe(1); // still 1 — 20 volume updates, zero TranscriptLog re-renders

    fireEvent.click(getByTestId("add-message"));
    expect(renderCount).toBe(2); // a real transcript change does re-render it
  });
});
