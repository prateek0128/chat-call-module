/** Call-UI hooks. */
import { useEffect, useState } from "react";
import { formatCallDuration, secondsSince } from "../core/callLog";

/** Running "MM:SS" since `connectedAt` (epoch ms), ticking every second; "" when not connected. */
export const useCallTimer = (connectedAt: number | null | undefined): string => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connectedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [connectedAt]);
  return connectedAt ? formatCallDuration(secondsSince(connectedAt, now)) : "";
};
