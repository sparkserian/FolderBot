// The window: title bar, navigation, the current page, and app-wide banners.
import {
  ArrowsClockwise,
  ClockCounterClockwise,
  GearSix,
  PencilSimpleLine,
  Pulse,
  type Icon as PhosphorIcon
} from "@phosphor-icons/react";
import { useEffect } from "react";
import { BrandMark } from "./components/BrandMark";
import { Button, InfoBar, Toasts } from "./components/ui";
import { ActivityPage } from "./pages/ActivityPage";
import { HistoryPage } from "./pages/HistoryPage";
import { RenamePage } from "./pages/RenamePage";
import { SettingsPage } from "./pages/SettingsPage";
import { api, navigate, useStore, type Route } from "./store";
import { summarizeWatcher } from "./watcherSummary";

const NAV: Array<{ route: Route; label: string; icon: PhosphorIcon }> = [
  { route: "activity", label: "Activity", icon: Pulse },
  { route: "rename", label: "Rename", icon: PencilSimpleLine },
  { route: "history", label: "History", icon: ClockCounterClockwise }
];

export function App() {
  const route = useStore((current) => current.route);
  const loaded = useStore((current) => current.loaded);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const target: Partial<Record<string, Route>> = { "1": "activity", "2": "rename", "3": "history", ",": "settings" };
      const next = target[event.key];
      if (next) {
        event.preventDefault();
        navigate(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <header className="titlebar">
        <BrandMark size={18} />
        <span className="titlebar-name">FolderBot</span>
      </header>

      <nav className="nav" aria-label="FolderBot">
        <ul className="nav-list">
          {NAV.map((item) => (
            <NavItem key={item.route} {...item} active={route === item.route} />
          ))}
        </ul>
        <div className="nav-footer">
          <WatcherSummary />
          <ul className="nav-list">
            <NavItem route="settings" label="Settings" icon={GearSix} active={route === "settings"} />
          </ul>
        </div>
      </nav>

      <main className="content" aria-busy={!loaded}>
        <UpdateBanner />
        <div className="page" key={route}>
          {route === "activity" ? <ActivityPage /> : null}
          {route === "rename" ? <RenamePage /> : null}
          {route === "history" ? <HistoryPage /> : null}
          {route === "settings" ? <SettingsPage /> : null}
        </div>
      </main>

      <Toasts />
    </div>
  );
}

function NavItem({ route, label, icon: IconComponent, active }: { route: Route; label: string; icon: PhosphorIcon; active: boolean }) {
  // Selectors must return primitives: a fresh object each read makes React re-render forever.
  const attention = useStore((current) =>
    route === "activity"
      ? current.automation.jobs.filter((job) => job.stage === "failed").length + current.automation.problems.length
      : 0
  );

  return (
    <li>
      <button type="button" className={`nav-item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => navigate(route)}>
        <IconComponent size={20} aria-hidden />
        <span className="nav-label">{label}</span>
        {attention > 0 ? <span className="nav-badge nav-badge-critical" aria-label={`${attention} need attention`}>{attention}</span> : null}
      </button>
    </li>
  );
}

// One line under the navigation saying what the watcher is doing, visible from every page.
function WatcherSummary() {
  const automation = useStore((current) => current.automation);
  const summary = summarizeWatcher(automation);

  return (
    <button type="button" className={`watcher-summary tone-${summary.tone}`} title={[summary.title, summary.detail].filter(Boolean).join(": ")} onClick={() => navigate("activity")}>
      <span className="watcher-dot" aria-hidden />
      <span className="watcher-text">
        <span className="watcher-title">{summary.title}</span>
        {summary.detail ? <span className="watcher-detail">{summary.detail}</span> : null}
      </span>
      {summary.percent !== undefined ? (
        <span className="watcher-ring" style={{ ["--percent" as string]: `${summary.percent}` }} aria-hidden />
      ) : null}
    </button>
  );
}

function UpdateBanner() {
  const update = useStore((current) => current.update);
  const processing = useStore((current) => current.automation.processing);

  if (update.kind !== "ready") {
    return null;
  }

  return (
    <div className="banner">
      <InfoBar
        tone="info"
        title={`FolderBot ${update.version} is ready to install`}
        actions={
          <Button
            variant="accent"
            size="small"
            icon={ArrowsClockwise}
            onClick={() => {
              if (processing && !window.confirm("A file is being filed right now. Restarting stops it, and it will start again afterwards. Restart anyway?")) {
                return;
              }
              void api.installUpdate();
            }}
          >
            Restart to update
          </Button>
        }
      >
        {processing ? "It installs when the current file is done, or restart now." : "It also installs the next time you quit FolderBot."}
      </InfoBar>
    </div>
  );
}
