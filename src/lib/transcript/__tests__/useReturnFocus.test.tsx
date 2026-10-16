import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReturnFocus } from "../useReturnFocus";

/** A stand-in for the button that opened the dialog. */
class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

const g = globalThis as unknown as Record<string, unknown>;

function grab() {
  let props: ReturnType<typeof useReturnFocus> | null = null;
  function Probe() {
    props = useReturnFocus();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return props!;
}

afterEach(() => {
  delete g.document;
  delete g.HTMLElement;
});

describe("useReturnFocus", () => {
  it("gives focus back to the element that had it when the dialog opened", () => {
    const opener = new FakeElement();
    g.HTMLElement = FakeElement;
    g.document = { activeElement: opener };
    const props = grab();

    props.onOpenAutoFocus();
    const event = { preventDefault: vi.fn() } as unknown as Event;
    props.onCloseAutoFocus(event);

    expect(opener.focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves the default alone when the opener is gone from the page", () => {
    const opener = new FakeElement();
    opener.isConnected = false;
    g.HTMLElement = FakeElement;
    g.document = { activeElement: opener };
    const props = grab();

    props.onOpenAutoFocus();
    const event = { preventDefault: vi.fn() } as unknown as Event;
    props.onCloseAutoFocus(event);

    expect(opener.focus).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
