// FR-9 read-path (frontend side): reads the D3R·AC data pipeline's output
// (data-pipeline/scripts/run_cycle.py writes this to
// frontend/public/data/communities.json every cycle) instead of a
// hardcoded mock array — without ever throwing or leaving the UI blank if
// the feed isn't there yet (e.g. the pipeline hasn't run in this
// environment, or is mid-deployment).
//
// The real long-term read-path is reading RiskRegistry.getCommunity
// directly once Hub/RiskRegistry are deployed (see
// docs/data-pipeline-srs.md's FR-9) — this static-JSON bridge exists
// because that isn't true yet. Swap fetchLiveCommunities' implementation
// for a chain read later without touching useCommunities' call sites.

import { COMMUNITIES, type Community } from "./riskModel";

const FEED_URL = import.meta.env.VITE_D3RAC_FEED_URL ?? "/data/communities.json";

interface PipelineCommunityRow {
  id: string;
  name: string;
  region: string;
  hazard: number;
  exposure: number;
  vulnerability: number;
  lastUpdated: string;
  hazardSource: string;
  stale: boolean;
}

interface PipelineFeed {
  generatedAt: string;
  communities: PipelineCommunityRow[];
}

export type FeedSource = "live" | "demo";

export interface CommunitiesResult {
  communities: Community[];
  source: FeedSource;
  generatedAt: string | null;
  staleCommunityIds: string[];
}

function isValidRow(row: unknown): row is PipelineCommunityRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.region === "string" &&
    isUnitInterval(r.hazard) &&
    isUnitInterval(r.exposure) &&
    isUnitInterval(r.vulnerability)
  );
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidFeed(data: unknown): data is PipelineFeed {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.communities) && d.communities.every(isValidRow);
}

// Milestone data (fundedMilestones/totalMilestones) comes from
// DisbursementController, a different contract the hazard pipeline knows
// nothing about — merged in here from the static demo dataset by id, or
// a neutral 0/1 default if a live community has no local match at all.
function mergeMilestones(row: PipelineCommunityRow): Community {
  const fallback = COMMUNITIES.find((c) => c.id === row.id);
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    hazard: row.hazard,
    exposure: row.exposure,
    vulnerability: row.vulnerability,
    fundedMilestones: fallback?.fundedMilestones ?? 0,
    totalMilestones: fallback?.totalMilestones ?? 1,
  };
}

/**
 * Fetches the pipeline's live feed. Never throws — any network error,
 * missing file (404, common if the pipeline hasn't run yet in this
 * environment), or malformed payload resolves to `null` instead, so
 * callers can fall back to demo data without a try/catch of their own.
 */
async function fetchLiveCommunities(): Promise<PipelineFeed | null> {
  try {
    const response = await fetch(FEED_URL, { cache: "no-store" });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (!isValidFeed(data) || data.communities.length === 0) return null;

    return data;
  } catch {
    // Network error, JSON parse error, or anything else — treat exactly
    // like "no feed available" rather than surfacing to the user.
    return null;
  }
}

/**
 * The single entry point the UI should use instead of importing
 * COMMUNITIES directly. Always resolves — never rejects — so a page
 * calling this can render demo data on first paint and never show an
 * error state purely because the live feed isn't reachable.
 */
export async function loadCommunities(): Promise<CommunitiesResult> {
  const feed = await fetchLiveCommunities();

  if (!feed) {
    return {
      communities: COMMUNITIES,
      source: "demo",
      generatedAt: null,
      staleCommunityIds: [],
    };
  }

  return {
    communities: feed.communities.map(mergeMilestones),
    source: "live",
    generatedAt: feed.generatedAt,
    staleCommunityIds: feed.communities.filter((c) => c.stale).map((c) => c.id),
  };
}
