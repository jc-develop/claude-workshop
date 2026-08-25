"use client";

import { ROLES } from "@/shared/lib/roles";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/utils";
import { EventCard } from "@/modules/events/components/event-card";
import { EventListSkeleton } from "@/modules/events/components/event-list-skeleton";
import { useSession } from "@/modules/auth/components/session-context";
import { roleHome } from "@/modules/auth/lib/role-home";
import { useEventList } from "@/modules/events/lib/use-event-list";
import type { EventListSeed, FilterTab } from "@/modules/events/lib/use-event-list";
import { LoadMoreButton } from "@/shared/components/load-more";
import { TableSearch } from "@/shared/components/table-toolbar";

/** Cards enter in sequence rather than all at once, capped so a full page of
 *  fifty does not spend two seconds arriving. */
const MAX_STAGGERED_CARDS = 8;
const STAGGER_MS = 40;

function riseDelay(index: number): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, MAX_STAGGERED_CARDS) * STAGGER_MS}ms` };
}

const ATTENDEE_TABS: { key: FilterTab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "completed", label: "Completed" },
];

export function EventListPage({ initial }: { initial?: EventListSeed } = {}) {
  const router = useRouter();
  const { user } = useSession();
  const {
    events,
    loading,
    refreshing,
    loadingMore,
    error,
    hasMore,
    loadMore,
    activeTab,
    setActiveTab,
    tabTotals,
    search,
    setSearch,
  } = useEventList({ initial });

  useEffect(() => {
    if (user && user.role !== ROLES.ATTENDEE) {
      router.replace(roleHome(user.role));
    }
  }, [user, router]);

  /**
   * The entry animation belongs to the list arriving, not to every set of rows
   * that ever occupies it afterwards.
   *
   * Typing only ever removes cards, so the flicker was on the way back: deleting
   * a character re-matches events, React mounts their cards afresh, and a mount
   * is what starts a CSS animation — so every backspace replayed the rise across
   * the grid, and coming back from a term that matched nothing replayed all of
   * it. The first refetch ends the intro for good; from then on a search swaps
   * rows in place with no motion at all, which is what makes it read as fast
   * rather than busy.
   *
   * Latched where the reader touches the controls rather than derived from the
   * refetch it causes: an effect watching `refreshing` would land a render mid
   * animation and cut the intro short for anyone who typed straight away, and
   * it is the interaction, not the request, that says the introduction is over.
   */
  const [introDone, setIntroDone] = useState(false);
  const intro = !introDone;

  const term = search.trim();
  const tabLabel = ATTENDEE_TABS.find((tab) => tab.key === activeTab)?.label.toLowerCase() ?? "";

  return (
    <div className="flex flex-1 flex-col p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-base font-bold text-fg">Event list</span>
      </div>

      {/* The heading, tabs and search sit outside every loading and error
          branch below. A refetch that unmounted them would drop the cursor out
          of the search box on the pause after each keystroke. */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label="Event status" className="flex gap-1.5">
          {ATTENDEE_TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => {
                setIntroDone(true);
                setActiveTab(tab.key);
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                activeTab === tab.key ? "bg-muted font-medium text-fg" : "text-muted-fg hover:bg-muted hover:text-fg",
              )}
            >
              {/* These are server totals rather than tallies of the rendered
                  page. Both attendee tabs are seeded by the route, so neither
                  badge waits for a tab click before it can render. */}
              {tab.label}
              {tabTotals[tab.key] !== undefined ? ` (${tabTotals[tab.key]})` : ""}
            </button>
          ))}
        </div>

        <TableSearch
          value={search}
          onChange={(value) => {
            setIntroDone(true);
            setSearch(value);
          }}
          placeholder="Search events"
          busy={refreshing}
          className="sm:w-72"
        />
      </div>

      {/* A failed refetch that still has rows behind it warns in place instead
          of throwing the list away — the same reason the hook keeps them. */}
      {error && events.length > 0 && (
        <p className="mb-3 text-sm text-error">Failed to refresh events — showing the last results loaded.</p>
      )}

      {/* Stale-while-revalidate: a search keeps the rows it is replacing on
          screen, rather than dropping to the skeleton and back. The skeleton is
          only ever the cold start — swapping it in over results unmounts the
          grid, and with a fixed six placeholders against a varying result count
          it resized the page on every keystroke.

          The rows are left entirely alone while the refetch runs, down to their
          opacity. Dimming them and undimming them drew a flicker across the
          whole page on every keystroke, and the slower the answer the more of
          one — exactly backwards for a progress signal. `TableSearch` carries
          the wait instead, in one small place beside the cursor, and `aria-busy`
          still reports it here. */}
      {loading ? (
        <EventListSkeleton />
      ) : error && events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-error">{error}</p>
        </div>
      ) : events.length === 0 ? (
        <div aria-busy={refreshing} className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-fg">{term ? `No ${tabLabel} events match “${term}”.` : "No events found."}</p>
        </div>
      ) : (
        <div aria-busy={refreshing} className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {events.map((event, index) => (
            <EventCard
              key={event.id}
              className={intro ? "card-rise" : undefined}
              style={intro ? riseDelay(index) : undefined}
              eventId={event.id}
              title={event.title}
              status={event.status}
              date={event.event_date}
              startTime={event.start_time}
              endTime={event.end_time}
              venueName={event.venue_name}
              eventType={event.event_type}
              coverImageUrl={event.cover_image_url}
              // The event's own id, not its position. Keyed on position, a card
              // that survived a search changed colour under the reader because
              // the rows above it had gone — the one thing on screen that was
              // supposed to be standing still.
              accentIndex={event.id}
            />
          ))}
        </div>
      )}

      {hasMore && <LoadMoreButton loading={loadingMore} onLoadMore={loadMore} />}
    </div>
  );
}
