import { useEffect, useState } from "react";
import { api } from "../api";

/** Sign-out control, shown only on Umbrel where a login is required. */
export function LogoutButton() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setShow(s.authRequired))
      .catch(() => {});
  }, []);

  if (!show) return null;

  return (
    <button className="refresh" title="Sign out of Lightning Mate" onClick={() => api.logout()}>
      ⏻ sign out
    </button>
  );
}
