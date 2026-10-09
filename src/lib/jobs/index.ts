/**
 * The normalized job shape.
 *
 * Re-exported here so the UI imports one name for "a job the app is willing to
 * show" rather than reaching into the pipeline's internals.
 */
export type {
  NormalizedJob,
  JobSearchMetadata,
  JobSearchResult,
  PostedAge,
  NormalizedSalary,
  ApplyOption,
  ExperienceLevel,
} from "@/lib/jobs/types";