// Pick the right show from TMDb or TheTVDB. Used before a manual rename (one question per show)
// and to fix the show of something the watcher already filed.
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { MetadataSourceId, ProviderSeriesSearchMatch } from "../../shared/types";
import { SOURCE_LABELS } from "../format";
import { api, describe } from "../store";
import { Button, Dialog, Spinner } from "./ui";

export function SeriesPicker({
  open,
  sourceId,
  initialQuery,
  title,
  subtitle,
  confirmLabel,
  skipLabel,
  onConfirm,
  onSkip,
  onClose
}: {
  open: boolean;
  sourceId: MetadataSourceId;
  initialQuery: string;
  title: string;
  subtitle?: string;
  confirmLabel: string;
  skipLabel?: string;
  onConfirm: (match: ProviderSeriesSearchMatch) => void | Promise<void>;
  onSkip?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<ProviderSeriesSearchMatch[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  const search = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        return;
      }
      setSearching(true);
      setError("");
      try {
        const found = await api.searchAutomationSeries({ sourceId, query: text.trim() });
        setResults(found);
        setSelected(0);
      } catch (searchError) {
        setResults([]);
        setError(describe(searchError));
      } finally {
        setSearching(false);
      }
    },
    [sourceId]
  );

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setResults([]);
      void search(initialQuery);
    }
  }, [open, initialQuery, search]);

  const match = results[selected];

  return (
    <Dialog
      open={open}
      wide
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          {skipLabel && onSkip ? (
            <Button variant="subtle" onClick={onSkip}>{skipLabel}</Button>
          ) : null}
          <span className="dialog-footer-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="accent"
            disabled={!match}
            busy={confirming}
            onClick={async () => {
              if (!match) return;
              setConfirming(true);
              try {
                await onConfirm(match);
              } finally {
                setConfirming(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="picker-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <label className="field">
          <span className="field-label">Search {SOURCE_LABELS[sourceId]}</span>
          <span className="field-row">
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Show title" />
            <Button type="submit" icon={MagnifyingGlass} busy={searching}>Search</Button>
          </span>
        </label>
      </form>

      <div className="picker-body">
        <div className="picker-results" role="listbox" aria-label="Matching shows">
          {searching ? (
            <div className="picker-empty"><Spinner /> Searching…</div>
          ) : error ? (
            <div className="picker-empty is-error">{error}</div>
          ) : results.length === 0 ? (
            <div className="picker-empty">No shows found. Try a shorter title.</div>
          ) : (
            results.map((result, index) => (
              <button
                key={`${result.providerSeriesId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === selected}
                className="picker-option"
                onClick={() => setSelected(index)}
                onDoubleClick={() => void onConfirm(result)}
              >
                <span className="picker-option-title">{result.title}</span>
                <span className="picker-option-year">{result.year ?? "—"}</span>
              </button>
            ))
          )}
        </div>
        <div className="picker-detail">
          {match ? (
            <>
              <strong>{match.title}</strong>
              <span className="muted">{[match.year, SOURCE_LABELS[match.sourceId]].filter(Boolean).join(" · ")}</span>
              <p>{match.summary || "No summary available for this show."}</p>
            </>
          ) : (
            <p className="muted">Choose a show to see its details.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
