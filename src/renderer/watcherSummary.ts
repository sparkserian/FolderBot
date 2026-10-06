// Turns the watcher status into one short headline, used by the navigation footer.
import type { AutomationStatus } from "../shared/types";
import { formatEta } from "./format";

export interface WatcherSummaryText {
  tone: "off" | "ok" | "busy" | "attention" | "waiting";
  title: string;
  detail?: string;
  percent?: number;
}

export function summarizeWatcher(status: AutomationStatus): WatcherSummaryText {
  if (!status.enabled) {
    return status.inboxDirectory
      ? { tone: "off", title: "Watcher paused", detail: "New downloads stay in the inbox" }
      : { tone: "off", title: "Automatic filing is off", detail: "Set it up in Settings" };
  }

  if (!status.watching && status.problems.length > 0) {
    return { tone: "attention", title: "Watcher needs setup", detail: status.problems[0].message };
  }

  const active = status.jobs.find((job) => job.stage === "copying" || job.stage === "moving" || job.stage === "matching");
  if (active) {
    const progress = active.progress;
    if (progress && progress.bytesTotal > 0 && active.stage !== "matching") {
      const percent = Math.floor((progress.bytesDone / progress.bytesTotal) * 100);
      return {
        tone: "busy",
        title: `${active.stage === "moving" ? "Moving" : "Copying"} ${percent}%`,
        detail: `${active.title || active.fileName} · ${formatEta(progress.etaSeconds)}`,
        percent
      };
    }
    return { tone: "busy", title: "Looking up", detail: active.fileName };
  }

  const failed = status.jobs.filter((job) => job.stage === "failed").length;
  if (status.problems.length > 0) {
    return { tone: "attention", title: "Needs attention", detail: status.problems[0].message };
  }
  if (failed > 0) {
    return { tone: "attention", title: `${failed} file${failed === 1 ? "" : "s"} could not be filed`, detail: "Open Activity to see why" };
  }

  const locked = status.jobs.filter((job) => job.stage === "locked").length;
  if (locked > 0) {
    return { tone: "waiting", title: `${locked} file${locked === 1 ? "" : "s"} in use`, detail: "Waiting for another program to let go" };
  }

  if (status.pendingCount > 0) {
    return { tone: "waiting", title: `${status.pendingCount} file${status.pendingCount === 1 ? "" : "s"} arriving`, detail: "Filed once they stop changing" };
  }

  return { tone: "ok", title: "Watching", detail: "Nothing to file right now" };
}
