import { Link } from "react-router-dom";
import { EmptyState } from "../components";
import "../layout/AppShell.css";

export function NotFound() {
  return (
    <div className="shell__inner">
      <EmptyState size="page" title="No page here" action={<Link to="/app">Go to your packages</Link>} />
    </div>
  );
}
