"use client";

import { mswReady } from "@/lib/msw-ready";

// 모듈 로드 시점(useEffect보다 앞)에 MSW 시작 Promise를 등록
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  mswReady.set(
    import("./browser")
      .then(({ worker }) =>
        worker.start({
          serviceWorker: { url: "/mock-service-worker.js" },
          onUnhandledRequest: "bypass",
        })
      )
      .then(() => undefined),
  );
}

export function MSWProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
