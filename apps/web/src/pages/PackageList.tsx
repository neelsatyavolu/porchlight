// The package list, grouped by arrival day (DESIGN.md §6). Keys: "/" search,
// "n" add, Escape clears the search.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, EmptyState, Input, SkeletonRows } from "../components";
import { usePackages } from "../data/packages";
import { usePackageActions } from "../packages/actions";
import { groupPackages, type ArrivalGroup } from "../packages/arrival";
import { useClock } from "../packages/clock";
import { matchesQuery } from "../packages/format";
import { useHotkeys } from "../packages/hotkeys";
import { pending, usePending } from "../packages/pending";
import { clockTime } from "../packages/time";
import { PackageRow } from "./list/PackageRow";
import "./list/List.css";

type View = "active" | "archived";

export function PackageList() {
  const { load, error, packages, sync } = usePackages();
  const { hidden, notice } = usePending();
  const { now, timeZone } = useClock();
  const actions = usePackageActions();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("active");
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (load === "ready" && error === null) setSyncedAt(new Date());
  }, [load, error, packages]);

  useHotkeys([
    { key: "/", run: () => searchRef.current?.querySelector("input")?.focus() },
    { key: "n", run: () => navigate("/app/add") },
    {
      key: "Escape",
      inFields: true,
      run: (e) => {
        const input = searchRef.current?.querySelector("input");
        if (e.target !== input && query === "") return;
        setQuery("");
        input?.blur();
      },
    },
  ]);

  const live = useMemo(() => packages.filter((p) => !hidden.has(p.id)), [packages, hidden]);
  const active = useMemo(() => live.filter((p) => p.archivedAt === null), [live]);
  const archived = useMemo(() => live.filter((p) => p.archivedAt !== null), [live]);
  const shown = useMemo(
    () => (view === "active" ? active : archived).filter((p) => matchesQuery(p, query)),
    [view, active, archived, query],
  );
  const groups = groupPackages(shown, now, timeZone);

  if (load === "loading") {
    return (
      <div className="list">
        <SkeletonRows count={4} label="Loading packages" />
      </div>
    );
  }

  if (load === "error") {
    return (
      <EmptyState
        size="page"
        title="Couldn't reach Porchlight"
        action={
          <Button variant="primary" onClick={() => void sync()}>
            Try again
          </Button>
        }
      >
        <p>{error}</p>
      </EmptyState>
    );
  }

  if (live.length === 0) {
    return (
      <EmptyState
        size="page"
        title="Nothing on the way"
        action={
          <Button variant="accent" onClick={() => navigate("/app/add")}>
            Add a package
          </Button>
        }
      >
        <p>Paste a tracking number, or connect Amazon in the Mac or iPhone app.</p>
      </EmptyState>
    );
  }

  async function archiveDelivered(group: ArrivalGroup) {
    setArchiving(true);
    setArchiveError(null);
    const results = await Promise.allSettled(group.packages.map((p) => actions.update(p.id, { archived: true })));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) setArchiveError(`Couldn't archive ${failed === 1 ? "1 package" : `${failed} packages`}. Try again.`);
    setArchiving(false);
  }

  return (
    <div className="list">
      <header className="list__head">
        <h1 className="list__title">Packages</h1>
        <div className="list__tools">
          <div className="list__search" ref={searchRef}>
            <Input
              label="Search packages"
              hideLabel
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {archived.length > 0 || view === "archived" ? (
            <div className="list__views" role="group" aria-label="Show">
              <Button size="sm" aria-pressed={view === "active"} onClick={() => setView("active")}>
                Active
              </Button>
              <Button size="sm" aria-pressed={view === "archived"} onClick={() => setView("archived")}>
                Archived <span className="num">{archived.length}</span>
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      {error !== null ? (
        <p className="list__note">
          {syncedAt ? `Couldn't refresh. Showing what we had at ${clockTime(syncedAt.toISOString(), timeZone)}.` : "Couldn't refresh."}
          <button type="button" className="text-button" onClick={() => void sync()}>
            Try again
          </button>
        </p>
      ) : null}

      {notice !== null ? (
        <p className="list__note" role="alert">
          {notice}
          <button type="button" className="text-button" onClick={() => pending.notify(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      {archiveError !== null ? (
        <p className="list__note" role="alert">
          {archiveError}
        </p>
      ) : null}

      {groups.length === 0 ? (
        query.trim() !== "" ? (
          <EmptyState title={`Nothing matches "${query.trim()}"`}>
            <p>Search looks at titles, merchants, items, carriers and tracking numbers.</p>
          </EmptyState>
        ) : (
          <EmptyState title={view === "archived" ? "Nothing archived" : "Nothing on the way"}>
            {view === "active" ? <p>Everything you track is archived.</p> : null}
          </EmptyState>
        )
      ) : (
        groups.map((group) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`}>
            <div className="group__header">
              <h2 id={`group-${group.id}`} className="group__title">
                {group.label}
                <span className="group__count num">{group.packages.length}</span>
              </h2>
              {group.id === "delivered" && view === "active" ? (
                <Button size="sm" busy={archiving} onClick={() => void archiveDelivered(group)}>
                  Archive all
                </Button>
              ) : null}
            </div>
            {group.packages.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} now={now} timeZone={timeZone} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
