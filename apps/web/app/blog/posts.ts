import type { ComponentType } from "react";
import CopilotCostPlaybook from "./_posts/copilot-cost-playbook";

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  readingMinutes: number;
  Body: ComponentType;
}

/** Newest first; the list page renders in this order. */
export const POSTS: Post[] = [
  {
    slug: "copilot-cost-playbook",
    title:
      "I stole GitHub Copilot's cost playbook for my open-source coding agent. One trick cut cost 23%. Their biggest one made mine worse.",
    description:
      "How four ideas from a GitHub engineering post became four experiments in FreeCode — and why the failed one taught me the most.",
    date: "2026-09-16",
    readingMinutes: 12,
    Body: CopilotCostPlaybook,
  },
];

export const postBySlug = (slug: string) => POSTS.find((p) => p.slug === slug);

export const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
