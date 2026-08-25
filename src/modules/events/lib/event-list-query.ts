import type { EventMode } from "@/shared/types";

interface Course {
  course_name: string;
}

export interface EventListItem {
  id: number;
  title: string;
  event_date: string;
  start_time: string;
  end_time: string;
  venue_name: string;
  venue_address: string | null;
  status: "draft" | "active" | "complete";
  event_type?: EventMode | null;
  cover_image_url: string | null;
  COURSE?: Course | null;
  attendee_count?: number;
  /** Seat cap, or null when uncapped. Read by the staff table's attendance cell. */
  capacity?: number | null;
}

export interface EventListSeed {
  rows: EventListItem[];
  total: number;
  /** Totals already known for tabs other than the seeded Upcoming rows. */
  tabTotals?: Partial<Record<FilterTab, number>>;
}

export type FilterTab = "upcoming" | "completed" | "drafts";

export const PAGE_SIZE = 50;

/**
 * What one tab asks the server for, in the shape `listEvents` takes.
 *
 * The tabs used to be a client-side filter over one unscoped page of fifty, so
 * a tab showed only the events of its kind that happened to fall in those fifty
 * rows — with fifty upcoming events on the books, Completed rendered empty while
 * the archive sat there in full. Each tab now paginates over its own set.
 *
 * Upcoming and Completed are windows on the calendar, not status values: a past
 * `active` event is served as complete without its column ever being advanced,
 * because `effectiveEventStatus` derives that from the end time. Asking for
 * `status=complete` would miss every one of those. The status set rides along
 * only to keep drafts out, since they have a tab of their own.
 *
 * Drafts is the exception and really is a status — a draft sits on either side
 * of today, so a date window would hide half of them.
 */
export function tabScope(tab: FilterTab, includeDrafts: boolean): { filter?: "upcoming" | "past"; statuses?: string[] } {
  switch (tab) {
    case "upcoming":
      return { filter: "upcoming", statuses: includeDrafts ? ["active", "draft"] : ["active"] };
    case "completed":
      return { filter: "past", statuses: ["active", "complete"] };
    case "drafts":
      return { statuses: ["draft"] };
  }
}

export interface EventListQuery {
  tab: FilterTab;
  /** Already trimmed; an empty string means no term rather than a blank one. */
  search: string;
  includeDrafts: boolean;
  page: number;
}

/** The `/api/events` query string for one page of one tab. */
export function eventListParams({ tab, search, includeDrafts, page }: EventListQuery): URLSearchParams {
  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  const scope = tabScope(tab, includeDrafts);
  if (scope.filter) params.set("filter", scope.filter);
  if (scope.statuses) params.set("status", scope.statuses.join(","));
  if (search) params.set("search", search);
  return params;
}

/** One page of the listing, plus whether the read succeeded at all — a failed
 *  read is not an empty one, and the caller keeps its rows on the difference. */
export interface EventListPage {
  rows: EventListItem[];
  hasMore: boolean;
  ok: boolean;
  total: number;
}

/**
 * Fetches one page of the listing.
 *
 * Deliberately not a hook and not in a `"use client"` file: this is the wire
 * format of `/api/events`, and keeping it here is what lets the server
 * component seeding the first page share `tabScope` with the client that
 * paginates it — the seed's filter and status set used to be a second copy,
 * free to drift from the tab it was seeding.
 */
export async function fetchEventListPage(query: EventListQuery): Promise<EventListPage> {
  try {
    const res = await fetch(`/api/events?${eventListParams(query)}`);
    if (!res.ok) return { rows: [], hasMore: false, ok: false, total: 0 };
    const data = await res.json();
    const rows = (Array.isArray(data.data) ? data.data : []) as EventListItem[];
    const total = data.total ?? 0;
    return { rows, hasMore: total > query.page * PAGE_SIZE, ok: true, total };
  } catch {
    // A rejected request or a body that is not JSON leaves the page on an
    // error rather than stranded on the loading skeleton forever.
    return { rows: [], hasMore: false, ok: false, total: 0 };
  }
}
