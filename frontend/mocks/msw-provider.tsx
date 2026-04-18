"use client";

import { useEffect, useState } from "react";

export function MSWProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") {
      setReady(true);
      return;
    }
    import("./browser").then(({ worker }) => {
      worker
        .start({
          serviceWorker: { url: "/mock-service-worker.js" },
          onUnhandledRequest: "bypass",
        })
        .then(() => setReady(true));
    });
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
