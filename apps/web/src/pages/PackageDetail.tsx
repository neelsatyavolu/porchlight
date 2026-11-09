// One package (DESIGN.md §6 "Detail"). Keys: Escape back to the list, "n" add.
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Package } from "../api/types";
import { Button, CarrierBadge, EmptyState, Sheet, SkeletonRows, StatusDot } from "../components";
import { usePackages } from "../data/packages";
import { carrierName } from "../lib/carriers";
import { usePackageActions } from "../packages/actions";
import { etaSentence } from "../packages/arrival";
import { useClock } from "../packages/clock";
import { carrierTrackingUrl, retryWait, rowTitle, sourceLabel } from "../packages/format";
import { useHotkeys } from "../packages/hotkeys";
import { usePending } from "../packages/pending";
import { deviceHint, noScansText, refreshText, sourceLine } from "../packages/provenance";
import { ago, fullDateTime } from "../packages/time";
import { Timeline } from "./detail/Timeline";
import { TitleEditor } from "./detail/TitleEditor";
import "./detail/Detail.css";

/** Set by the add page when the number was already tracked. */
export interface DetailLocationState {
  note?: string;
}

interface RefreshState {
  busy: boolean;
  message: string | null;
  /** ISO; the button stays off until then. */
  nextAllowedAt: string | null;
}

const IDLE_REFRESH: RefreshState = { busy: false, message: null, nextAllowedAt: null };

function errorText(err: unknown, fallback: string): string {
  if (isApiError(err, "network")) return `${fallback} Check your connection and try again.`;
  return `${fallback} Try again.`;
}

export function PackageDetail() {
  const { id = "" } = useParams();
  const { load, get, eventsFor } = usePackages();
  const { hidden } = usePending();
  const { now, timeZone } = useClock();
  const actions = usePackageActions();
  const navigate = useNavigate();
  const note = (useLocation().state as DetailLocationState | null)?.note ?? null;

  const [refresh, setRefresh] = useState<RefreshState>(IDLE_REFRESH);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  // The Copy button's label goes back after 2 s; the timer dies with the page.
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useHotkeys([
    { key: "Escape", run: () => navigate("/app") },
    { key: "n", run: () => navigate("/app/add") },
  ]);

  const pkg = hidden.has(id) ? undefined : get(id);

  if (load === "loading") {
    return (
      <div className="detail">
        <SkeletonRows count={4} dots={false} label="Loading package" />
      </div>
    );
  }
  if (!pkg) {
    return (
      <EmptyState size="page" title="This package isn't here" action={<Link to="/app">Back to packages</Link>}>
        <p>It may have been deleted on another device.</p>
      </EmptyState>
    );
  }

  const carrier = carrierName(pkg.carrier);
  const events = eventsFor(pkg.id);
  const trackingUrl = carrierTrackingUrl(pkg.carrier, pkg.trackingNumber);
  const archived = pkg.archivedAt !== null;
  const source = sourceLine(pkg, now);
  const hint = deviceHint(pkg, now);
  const waiting = refresh.nextAllowedAt !== null && Date.parse(refresh.nextAllowedAt) > now.getTime();

  async function rename(title: string | null) {
    setActionError(null);
    try {
      await actions.update(id, { title });
    } catch (err) {
      setActionError(errorText(err, "Couldn't rename this package."));
    }
  }

  async function toggleArchive(target: Package) {
    setActionError(null);
    setArchiving(true);
    try {
      await actions.update(target.id, { archived: target.archivedAt === null });
    } catch (err) {
      setActionError(errorText(err, target.archivedAt === null ? "Couldn't archive this package." : "Couldn't unarchive this package."));
    } finally {
      setArchiving(false);
    }
  }

  async function runRefresh(pkg: Package) {
    setRefresh({ ...IDLE_REFRESH, busy: true });
    try {
      const res = await actions.refresh(id);
      setRefresh({
        busy: false,
        message: refreshText(pkg),
        nextAllowedAt: res.nextAllowedAt,
      });
    } catch (err) {
      if (isApiError(err, "rate_limited")) {
        const wait = err.retryAfter ?? 120;
        setRefresh({
          busy: false,
          message: `Checked recently. Try again in ${retryWait(wait)}.`,
          nextAllowedAt: new Date(now.getTime() + wait * 1000).toISOString(),
        });
      } else {
        setRefresh({ ...IDLE_REFRESH, message: errorText(err, "Couldn't ask for an update.") });
      }
    }
  }

  async function copyNumber(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  function deleteNow() {
    setConfirmDelete(false);
    navigate("/app");
    // The list hides it at once; a failure brings it back with a note there.
    actions.remove(id).catch(() => undefined);
  }

  return (
    <article className="detail">
      <Link to="/app" className="detail__back">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Packages
      </Link>

      {note ? <p className="detail__note">{note}</p> : null}

      <header className="detail__head">
        <TitleEditor display={rowTitle(pkg)} title={pkg.title} onSave={(t) => void rename(t)} />
        <p className="detail__status">
          <StatusDot status={pkg.status} withLabel />
          <span className="detail__eta">{etaSentence(pkg, carrier, now, timeZone)}</span>
        </p>
        {pkg.statusDetail ? <p className="detail__carrier-words">{pkg.statusDetail}</p> : null}
      </header>

      <dl className="facts">
        <div className="facts__row">
          <dt>Carrier</dt>
          <dd className="facts__value">
            <CarrierBadge carrier={pkg.carrier} />
            {trackingUrl ? (
              <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="facts__link">
                Track on {carrier} site
              </a>
            ) : null}
          </dd>
        </div>
        <div className="facts__row">
          <dt>Tracking number</dt>
          <dd className="facts__value">
            <span className="mono facts__number">{pkg.trackingNumber}</span>
            <Button size="sm" onClick={() => void copyNumber(pkg.trackingNumber)} aria-live="polite">
              {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
            </Button>
          </dd>
        </div>
        {pkg.merchant ? (
          <div className="facts__row">
            <dt>Merchant</dt>
            <dd>{pkg.merchant}</dd>
          </div>
        ) : null}
        {pkg.orderId ? (
          <div className="facts__row">
            <dt>Order</dt>
            <dd className="mono">{pkg.orderId}</dd>
          </div>
        ) : null}
        <div className="facts__row">
          <dt>Source</dt>
          <dd>{sourceLabel(pkg.source)}</dd>
        </div>
        <div className="facts__row">
          <dt>Last checked</dt>
          <dd className="num">
            {pkg.lastCheckedAt ? (
              <time dateTime={pkg.lastCheckedAt} title={fullDateTime(pkg.lastCheckedAt, timeZone)}>
                {ago(pkg.lastCheckedAt, now)}
              </time>
            ) : (
              "Not checked yet"
            )}
          </dd>
        </div>
      </dl>

      {pkg.items.length > 0 ? (
        <section className="detail__section" aria-labelledby="detail-items">
          <h2 id="detail-items" className="detail__section-title">
            Items
          </h2>
          <ul className="items">
            {pkg.items.map((item, i) => (
              <li key={`${i}-${item.name}`} className="items__row">
                <span className="items__name">{item.name}</span>
                <span className="items__qty num">{item.quantity > 1 ? `Qty ${item.quantity}` : null}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="detail__section" aria-labelledby="detail-timeline">
        <h2 id="detail-timeline" className="detail__section-title">
          Timeline
        </h2>
        {events.length > 0 ? (
          <Timeline events={events} status={pkg.status} now={now} timeZone={timeZone} />
        ) : (
          <EmptyState title="No scans yet">
            <p>{noScansText(pkg)}</p>
          </EmptyState>
        )}
        {source || pkg.attribution || hint ? (
          <footer className="detail__provenance">
            {hint ? <p className="detail__hint">{hint}</p> : null}
            {source ? <p>{source}</p> : null}
            {pkg.attribution ? <p className="detail__attribution">{pkg.attribution}</p> : null}
          </footer>
        ) : null}
      </section>

      <div className="detail__actions">
        <Button busy={refresh.busy} disabled={waiting} onClick={() => void runRefresh(pkg)}>
          Refresh
        </Button>
        <Button busy={archiving} onClick={() => void toggleArchive(pkg)}>
          {archived ? "Unarchive" : "Archive"}
        </Button>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
      </div>
      {refresh.message ? (
        <p className="detail__message" role="status">
          {refresh.message}
        </p>
      ) : null}
      {actionError ? (
        <p className="detail__message detail__message--error" role="alert">
          {actionError}
        </p>
      ) : null}

      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this package?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={deleteNow}>
              Delete
            </Button>
          </>
        }
      >
        <p>
          Porchlight stops tracking {rowTitle(pkg)} on all your devices. This can't be undone; to hide it instead, archive
          it.
        </p>
      </Sheet>
    </article>
  );
}
