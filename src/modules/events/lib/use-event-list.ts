"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/shared/lib/use-debounced-value";
import { fetchEventListPage, PAGE_SIZE } from "@/modules/events/lib/event-list-query";
import type { EventListItem, EventListSeed, FilterTab } from "@/modules/events/lib/event-list-query";

// The query moved to a module the server seed can import; these re-exports keep
// every call site pointing at the hook, the way `event-service` fronts the files
// it was split into.
export { PAGE_SIZE };
export type { EventListItem, EventListSeed, FilterTab };

interface UseEventListOptions {
  /**
   * Include drafts under Upcoming. The general listing keeps drafts in their
   * own tab, but a facilitator's assigned view must not hide an unpublished
   * event they have been assigned to run.
   */
  upcomingIncludesDrafts?: boolean;
  /**
   * The first page, already fetched on the server.
   *
   * Without it the page renders empty, hydrates, and only then asks for its
   * rows — three round trips before anything appears, which is why /events felt
   * slower than the landing page for the same data. The seed only answers the
   * query this hook opens on (Upcoming, no search); every tab and every
   * keystroke after that is fetched as before.
   */
  initial?: EventListSeed;
}

export function useEventList(options?: UseEventListOptions) {
  const seed = options?.initial;
  const [events, setEvents] = useState<EventListItem[]>(seed?.rows ?? []);
  const [loading, setLoading] = useState(!seed);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState((seed?.total ?? 0) > PAGE_SIZE);
  const [total, setTotal] = useState(seed?.total ?? 0);
  const [tabTotals, setTabTotals] = useState<Partial<Record<FilterTab, number>>>(() =>
    seed ? { ...seed.tabTotals, upcoming: seed.total } : {},
  );
  const [activeTab, setActiveTab] = useState<FilterTab>("upcoming");
  const [search, setSearch] = useState("");
  const pageRef = useRef(1);
  // Whether a first page has ever landed. A skeleton answers "there is nothing
  // here yet"; once rows exist, tearing them down to say so again is the flicker
  // a search felt like. After this flips, a refetch keeps the current rows up
  // and reports itself through `refreshing` instead. Not derived from
  // `events.length`, or a search matching nothing would arm the skeleton for
  // the next keystroke.
  const loadedOnceRef = useRef(!!seed);
  // A ref rather than the state flag: two clicks landing in one render both read
  // the same stale `loadingMore` and fetched the same page twice.
  const loadingMoreRef = useRef(false);

  // Trimmed so a trailing space doesn't change the query and trigger a
  // spurious refetch; the raw value still shows in the input.
  const debouncedSearch = useDebouncedValue(search.trim());

  // Read off `options` once, as a primitive. Every caller passes an object
  // literal, so depending on the option through `options?.` gave the fetch a
  // dependency with a new identity on every render.
  const includeDrafts = options?.upcomingIncludesDrafts === true;

  // Which query the state currently holds the answer to. The effect below skips
  // itself while that is still the query being asked, which is what stops the
  // seeded first page from being fetched a second time on hydration.
  //
  // Deliberately keyed on the query rather than counted down on first run: in
  // development React mounts, unmounts and remounts, so a "skip once" flag is
  // spent by the discarded pass and the real one refetches anyway — which is
  // exactly what this looked like it was doing until the network was checked.
  //
  // Cleared the moment a different query is asked, so returning to Upcoming
  // later refetches rather than re-showing rows another tab has since replaced.
  const queryKey = `${activeTab}|${debouncedSearch}|${includeDrafts}`;
  const seededKeyRef = useRef(seed ? `upcoming||${includeDrafts}` : null);

  /**
   * Which listing the rows on screen belong to.
   *
   * Every request reads this when it is sent and checks it again when it lands,
   * and may only write state if the two agree. A per-effect `cancelled` flag
   * covered the first page but could not cover pagination, because `loadMore`
   * is not an effect and has no cleanup: a page two in flight when a search
   * landed appended the old tab's rows underneath the new tab's, and left
   * `hasMore` and `total` describing a list nobody was looking at.
   */
  const generationRef = useRef(0);

  const load = useCallback(
    (page: number) => fetchEventListPage({ tab: activeTab, search: debouncedSearch, includeDrafts, page }),
    [debouncedSearch, activeTab, includeDrafts],
  );

  useEffect(() => {
    if (seededKeyRef.current === queryKey) return;
    seededKeyRef.current = null;

    const generation = ++generationRef.current;
    // Pagination belongs to the query that opened it, so a new one starts back
    // at page one with no page-two request outstanding against it.
    pageRef.current = 1;
    loadingMoreRef.current = false;
    setLoadingMore(false);

    async function loadFirstPage() {
      if (loadedOnceRef.current) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const result = await load(1);
      // Not on a superseded run: that one leaves every flag to its replacement.
      // Guarding only `loading` let the discarded run's data still land.
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        // Keep the rows already on screen: wiping them on a failed search is
        // the whole-page blanking this refetch path exists to avoid.
        setError("Failed to load events");
        setHasMore(false);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      setEvents(result.rows);
      setHasMore(result.hasMore);
      setTotal(result.total);
      setTabTotals((previous) => ({ ...previous, [activeTab]: result.total }));
      loadedOnceRef.current = true;
      setLoading(false);
      setRefreshing(false);
    }

    loadFirstPage();
    return () => {
      // An unmount has no successor to advance the generation, so this does it.
      //
      // The exhaustive-deps warning here is the inverse of what this needs: it
      // asks for the value copied in at effect time, and reading the current
      // one is the entire point — a counter, not a DOM node whose identity has
      // gone stale.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generationRef.current++;
    };
  }, [activeTab, load, queryKey]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const generation = generationRef.current;
    const next = pageRef.current + 1;
    setLoadingMore(true);

    const result = await load(next);

    // A tab or a search landed while this page was in flight. Its rows belong
    // to a listing that is no longer on screen, and the effect has already
    // reset the pagination this would otherwise advance.
    if (generation !== generationRef.current) return;

    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!result.ok) {
      // `pageRef` deliberately stays where it was: advanced before the request,
      // a failed page two left the cursor on two, so the retry asked for three
      // and page two's rows became unreachable without reloading the page.
      setError("Failed to load events");
      return;
    }
    pageRef.current = next;
    setEvents((prev) => [...prev, ...result.rows]);
    setHasMore(result.hasMore);
  }, [load]);

  return {
    /**
     * The rows the server returned for the open tab — not re-filtered here.
     *
     * A client-side pass over `status` used to run on top of this, left from
     * when the tabs were one unscoped page split three ways. It was redundant
     * once each tab became its own query, and it was destructive during the
     * refetch: `activeTab` changes on the click, so every row on screen failed
     * the new tab's test immediately and the grid flashed "No events found."
     * for a round trip before the real rows arrived. Serving the previous rows
     * dimmed, exactly as a search does, is the behaviour the dim exists for.
     */
    events,
    loading,
    refreshing,
    loadingMore,
    error,
    hasMore,
    loadMore,
    activeTab,
    setActiveTab,
    /** How many events the active tab holds in total, not just on the page fetched. */
    total,
    /** Totals available for each tab; the route seeds both attendee tabs. */
    tabTotals,
    search,
    setSearch,
  };
}
