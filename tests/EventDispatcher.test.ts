import { describe, expect, it, vi } from "vitest";
import { EventDispatcher } from "../src/events";

interface TestEvents {
  foo: { value: number };
}

describe("EventDispatcher", () => {
  it("does not evaluate payload factories when no listeners are registered", () => {
    const dispatcher = new EventDispatcher<TestEvents>();
    const factory = vi.fn(() => ({ value: 42 }));

    dispatcher.emitLazy("foo", factory);
    expect(factory).not.toHaveBeenCalled();
  });

  it("invokes payload factory once and shares payload across listeners", () => {
    const dispatcher = new EventDispatcher<TestEvents>();
    const factory = vi.fn(() => ({ value: 7 }));
    const first = vi.fn();
    const second = vi.fn();

    dispatcher.on("foo", first);
    dispatcher.on("foo", second);

    dispatcher.emitLazy("foo", factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ value: 7 });
    expect(second).toHaveBeenCalledWith({ value: 7 });
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
  });
});
