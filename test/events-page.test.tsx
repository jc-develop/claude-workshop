// @vitest-environment jsdom
import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { EventListPage } from "@/modules/events/pages/event-list";

vi.mock("@/modules/auth/components/session-context", () => ({ useSession: vi.fn() }));

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

import { useSession } from "@/modules/auth/components/session-context";

const events = [
  {
    id: 41,
    title: "Alpha",
    event_date: "2026-08-12",
    start_time: "09:00:00",
    end_time: "17:00:00",
    venue_name: "Hall A",
    venue_address: null,
    status: "active",
    cover_image_url: null,
    COURSE: null,
  },
  {
    id: 42,
    title: "Beta",
    event_date: "2026-08-20",
    start_time: "10:00:00",
    end_time: "18:00:00",
    venue_name: "Hall B",
    venue_address: null,
    status: "active",
    cover_image_url: null,
    COURSE: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;
  useSessionMock.mockReturnValue({
    user: { id: 1, role: ROLES.ATTENDEE, full_name: "Jane", email: "jane@example.com", profile_image_url: null },
    loading: false,
    isSignedIn: true,
    signOut: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: events, total: events.length, page: 1, limit: 50 }) }),
  );
});

afterEach(() => {
  // RTL's auto-cleanup keys off the global afterEach, which vitest does not
  // expose here (globals disabled). Without an explicit unmount the previous
  // test's tree stays in the document and every later query sees double.
  cleanup();
  vi.unstubAllGlobals();
});

describe("EventListPage event list", () => {
  it("links each card to /events/<id> using the API's id column", async () => {
    render(<EventListPage />);

    const links = await screen.findAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));

    expect(hrefs).toContain("/events/41");
    expect(hrefs).toContain("/events/42");
  });
});

describe("EventListPage for a signed-in non-attendee", () => {
  it.each([
    [ROLES.SPEAKER, "/speaker/events"],
    [ROLES.FACILITATOR, "/staff/events/assigned"],
    [ROLES.ADMIN, "/staff/events"],
  ])("sends %s to %s instead of the staff list", async (role, dest) => {
    const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;
    useSessionMock.mockReturnValue({
      user: { id: 1, role, full_name: "Sam", email: "sam@example.com", profile_image_url: null },
      loading: false,
      isSignedIn: true,
      signOut: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], total: 0, page: 1, limit: 50 }) }),
    );

    render(<EventListPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(dest));
  });
});

describe("EventListPage for a signed-out visitor", () => {
  it("renders the published events served by the public API", async () => {
    const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;
    useSessionMock.mockReturnValue({
      user: null,
      loading: false,
      isSignedIn: false,
      signOut: vi.fn(),
    });

    render(<EventListPage />);

    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("shows the failure message when the API rejects the anonymous call", async () => {
    const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;
    useSessionMock.mockReturnValue({
      user: null,
      loading: false,
      isSignedIn: false,
      signOut: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<EventListPage />);

    expect(await screen.findByText("Failed to load events")).toBeTruthy();
  });
});

describe("events page loading state", () => {
  it("reserves the list's height instead of collapsing to a one-line message", async () => {
    // The app shell renders the footer with `mt-auto`. A short loading state
    // parks it inside the viewport, and the arriving list then shoves it down —
    // 0.141 of the 0.142 CLS Lighthouse measured on this page.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<EventListPage />);

    expect(screen.getByLabelText("Loading events")).toBeTruthy();
    expect(screen.queryByText("Loading events...")).toBeNull();
  });

  it("shows enough placeholders to push the footer past the fold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    const { container } = render(<EventListPage />);

    // Six cards at the real card height clears any realistic viewport.
    expect(container.querySelectorAll(".h-48").length).toBe(6);
  });
});

describe("events page search", () => {
  it("sends the term to the API after the debounce, not on every keystroke", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return { ok: true, json: async () => ({ data: events, total: events.length, page: 1, limit: 50 }) };
      }),
    );

    render(<EventListPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(urls[urls.length - 1]).toBe("/api/events?page=1&limit=50&filter=upcoming&status=active");

    fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "summit" } });
    expect(urls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(urls[urls.length - 1]).toBe("/api/events?page=1&limit=50&filter=upcoming&status=active&search=summit");

    vi.useRealTimers();
  });

  // The whole page used to be replaced by the skeleton while a fetch was in
  // flight. With a search box on it that meant the input unmounting on the
  // pause after each keystroke, taking the cursor and the caret position out
  // of it — search would have been unusable.
  it("keeps the search box and tabs mounted while the refetch is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<EventListPage />);

    expect(screen.getByLabelText("Loading events")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search events" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Upcoming/ })).toBeTruthy();
  });

  it("says which tab came up empty and what was searched for", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [], total: 0, page: 1, limit: 50 }) })),
    );

    render(<EventListPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("No events found.")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "nothing" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getByText("No upcoming events match “nothing”.")).toBeTruthy();

    vi.useRealTimers();
  });
});

describe("events page tabs", () => {
  it("marks the selected tab for assistive technology, not by weight alone", async () => {
    render(<EventListPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Upcoming/ })).toBeTruthy());

    const upcoming = screen.getByRole("tab", { name: /Upcoming/ });
    const completed = screen.getByRole("tab", { name: /Completed/ });

    expect(upcoming.getAttribute("aria-selected")).toBe("true");
    expect(completed.getAttribute("aria-selected")).toBe("false");
  });

  // `text-foreground`, `text-muted-foreground` and `bg-surface-hover` are not
  // tokens in this theme, so Tailwind emitted no rule for them and the two tabs
  // rendered the same colour on the same transparent background — the selected
  // one was distinguishable only by font weight.
  it("distinguishes the selected tab with classes the theme actually defines", async () => {
    render(<EventListPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Upcoming/ })).toBeTruthy());

    const upcoming = screen.getByRole("tab", { name: /Upcoming/ });
    const completed = screen.getByRole("tab", { name: /Completed/ });

    expect(upcoming.className).toContain("bg-muted");
    expect(upcoming.className).toContain("text-fg");
    expect(completed.className).toContain("text-muted-fg");
    for (const tab of [upcoming, completed]) {
      expect(tab.className).not.toContain("surface-hover");
      expect(tab.className).not.toContain("foreground");
    }
  });

  // The tabs were a client-side filter over one unscoped page of fifty, so a
  // tab could only ever show the events of its kind that happened to fall in
  // those fifty rows. Fifty upcoming events on the books and Completed rendered
  // empty with the whole archive sitting behind it.
  it("asks the server for each tab's own set rather than filtering one page", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("filter=past")
          ? { data: [{ ...events[0], id: 99, title: "Archived summit", status: "complete" }], total: 1, page: 1, limit: 50 }
          : { data: [], total: 0, page: 1, limit: 50 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<EventListPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Completed/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: /Completed/ }));

    await waitFor(() => expect(screen.getByText("Archived summit")).toBeTruthy());
    // Drafts are staff-only and have a tab of their own, so the archive asks
    // for the two statuses that can legitimately read as finished.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("filter=past"))).toBe(true);
  });

  it("shows the server totals for both tabs on the initial render", () => {
    render(
      <EventListPage initial={{ rows: [{ ...events[0], status: "active" }], total: 137, tabTotals: { completed: 23 } }} />,
    );

    expect(screen.getByRole("tab", { name: /Upcoming/ }).textContent).toBe("Upcoming (137)");
    expect(screen.getByRole("tab", { name: /Completed/ }).textContent).toBe("Completed (23)");
  });

  it("counts the whole of the open tab, not the page that happens to be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [events[0]], total: 137, page: 1, limit: 50 }),
      })),
    );

    render(<EventListPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Upcoming/ }).textContent).toBe("Upcoming (137)"));

    // Without a server seed, the inactive tab is still unknown.
    expect(screen.getByRole("tab", { name: /Completed/ }).textContent).toBe("Completed");
  });
});

describe("events page card transitions", () => {
  // Keyed on position, the accent gradient was a function of how many rows sat
  // above a card. A search that removed those rows recoloured every card that
  // had survived it — the cards standing still were the ones that moved.
  it("keeps a surviving card's accent when a search removes the rows above it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).includes("search=Beta")
            ? { data: [events[1]], total: 1, page: 1, limit: 50 }
            : { data: events, total: events.length, page: 1, limit: 50 },
      })),
    );

    const { container } = render(<EventListPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const accentOf = (title: string) =>
      Array.from(container.querySelectorAll("a"))
        .find((link) => link.textContent?.includes(title))
        ?.querySelector('[class*="bg-gradient-to-br"]')?.className;
    const before = accentOf("Beta");
    expect(before).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "Beta" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.queryByText("Alpha")).toBeNull();
    expect(accentOf("Beta")).toBe(before);

    vi.useRealTimers();
  });

  it("staggers each card's entry, capped so a full page does not trickle in", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...events[0], id: 100 + i, title: `Event ${i}` }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: many, total: many.length, page: 1, limit: 50 }) })),
    );

    const { container } = render(<EventListPage />);
    await waitFor(() => expect(screen.getByText("Event 0")).toBeTruthy());

    const delays = Array.from(container.querySelectorAll<HTMLElement>("a.card-rise")).map((card) => card.style.animationDelay);
    expect(delays.slice(0, 3)).toEqual(["0ms", "40ms", "80ms"]);
    expect(delays[delays.length - 1]).toBe("320ms");
  });

  // The grid used to dim while a refetch was in flight, which meant fading it
  // down and back up on every keystroke — a flicker across the whole page, and
  // a worse one the slower the answer. The rows are now left alone entirely and
  // the wait is reported beside the cursor instead.
  it("leaves the rows untouched while a refetch is in flight", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("search=")) await gate;
        return { ok: true, json: async () => ({ data: events, total: events.length, page: 1, limit: 50 }) };
      }),
    );

    render(<EventListPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const grid = () => screen.getByText("Alpha").closest("[aria-busy]") as HTMLElement;
    const settled = grid().className;

    fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "a" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(grid().getAttribute("aria-busy")).toBe("true");
    expect(grid().className).toBe(settled);
    expect(grid().className).not.toContain("opacity-");
    // The wait shows on the search box, and only after a quarter second, so a
    // fast answer never draws an indicator at all.
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
    expect(spinner?.className).toContain("settle-in");

    await act(async () => {
      release!();
    });

    expect(grid().getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector(".animate-spin")).toBeNull();

    vi.useRealTimers();
  });

  // Typing only ever removes cards; the flicker was on the way back. Deleting a
  // character re-matches events, React mounts their cards afresh, and a mount is
  // what starts a CSS animation — so every backspace replayed the rise across
  // the grid.
  it("does not replay the entry animation when a search widens again", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const rows = String(url).includes("search=Alpha") ? [events[0]] : events;
        return { ok: true, json: async () => ({ data: rows, total: rows.length, page: 1, limit: 50 }) };
      }),
    );

    const { container } = render(<EventListPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The list arriving is the one time the cards are animated in.
    expect(container.querySelectorAll("a.card-rise")).toHaveLength(2);

    const box = screen.getByRole("textbox", { name: "Search events" });
    fireEvent.change(box, { target: { value: "Alpha" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByText("Beta")).toBeNull();

    fireEvent.change(box, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Beta is back, and nothing on screen is carrying the entry animation.
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(container.querySelectorAll("a.card-rise")).toHaveLength(0);

    vi.useRealTimers();
  });
});

describe("events page tab switching", () => {
  // `activeTab` changed on the click while the rows on screen still belonged to
  // the old tab, and a client-side re-filter over `status` failed every one of
  // them at once — so the grid flashed "No events found." for a round trip
  // before the archive arrived. The rows a tab is replacing now stay up dimmed,
  // exactly as a search's do.
  it("does not flash the empty state while the new tab is in flight", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("filter=past")) await gate;
        return { ok: true, json: async () => ({ data: events, total: events.length, page: 1, limit: 50 }) };
      }),
    );

    render(<EventListPage />);
    expect(await screen.findByText("Alpha")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Completed/ }));

    // Mid-switch: the previous rows are still up, dimmed, and no empty state.
    await waitFor(() => expect(screen.getByText("Alpha").closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("true"));
    expect(screen.queryByText("No events found.")).toBeNull();
    expect(screen.queryByLabelText("Loading events")).toBeNull();

    await act(async () => {
      release!();
    });

    await waitFor(() => expect(screen.getByText("Alpha").closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("false"));
  });
});
