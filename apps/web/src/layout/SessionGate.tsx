import type { ReactNode } from "react";
import { Button, EmptyState } from "../components";
import { RequireSession, useSession } from "../session";
import "./AppShell.css";

/** RequireSession plus the one state it can't decide: /me failed for a reason other than 401. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { state, reload } = useSession();
  if (state.status === "error") {
    return (
      <div className="shell__inner">
        <EmptyState
          size="page"
          title="Couldn't reach Porchlight"
          action={
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
          }
        >
          <p>{state.message}</p>
        </EmptyState>
      </div>
    );
  }
  return <RequireSession>{children}</RequireSession>;
}
