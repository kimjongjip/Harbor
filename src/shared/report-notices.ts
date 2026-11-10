import { z } from "zod";

// A private, host-local feed, read through Harbor's authenticated file API.
// Keeping it independent of a CLI session also permits delivery while Harbor is closed.
export const REPORT_DIRECTORY = "~/.harbor/reports";
export const reportId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const reportSummarySchema = z.object({
  id: reportId,
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  at: z.number().int().positive().max(8.64e15),
});
export const reportSchema = reportSummarySchema.extend({
  version: z.literal(1),
  markdown: z.string().trim().min(1).max(100000),
});
export const reportFeedSchema = z
  .object({
    version: z.literal(1),
    reports: z.array(reportSummarySchema).max(200),
  })
  .refine(
    (value) =>
      new Set(value.reports.map((report) => report.id)).size ===
      value.reports.length,
    "Duplicate report IDs",
  );
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type Report = z.infer<typeof reportSchema>;
export function reportFile(id: string) {
  return `${REPORT_DIRECTORY}/${reportId.parse(id)}.json`;
}
