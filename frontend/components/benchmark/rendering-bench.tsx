"use client";

import { useRef, useState } from "react";
import { fetchPosts } from "@/lib/api/posts";
import type { PostListItem } from "@/types/post";
import { NaiveBulkList } from "./naive-bulk-list";

const PRESETS = [
  { label: "1,000건", count: 1_000 },
  { label: "10,000건", count: 10_000 },
  { label: "100,000건", count: 100_000 },
] as const;

interface Metrics {
  count: number;
  fetchMs: number;
  renderMs: number;
  heapMB: number | null;
}

export function RenderingBench() {
  const [items, setItems] = useState<PostListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const pending = useRef<{ count: number; fetchMs: number } | null>(null);

  async function runBenchmark(count: number) {
    setLoading(true);
    setItems([]);
    setMetrics(null);
    pending.current = null;

    const fetchStart = performance.now();
    const res = await fetchPosts(1, count);
    const fetchMs = performance.now() - fetchStart;

    pending.current = { count, fetchMs };
    setItems(res.items);
    setLoading(false);
  }

  function handleRenderComplete(renderMs: number) {
    const p = pending.current;
    if (!p) return;
    pending.current = null;

    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const heapMB = mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null;

    setMetrics({
      count: p.count,
      fetchMs: p.fetchMs,
      renderMs: Math.round(renderMs),
      heapMB,
    });
  }

  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      {/* 헤더 */}
      <div className="flex items-end justify-between mb-1 pb-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            렌더링 병목 체험
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            FE Phase 2 — Naive Bulk Rendering
          </p>
        </div>
      </div>

      {/* 프리셋 버튼 */}
      <div className="flex gap-3 mt-6">
        {PRESETS.map(({ label, count }) => (
          <button
            key={count}
            type="button"
            onClick={() => runBenchmark(count)}
            disabled={loading}
            className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-amber-600 mt-2 mb-6">
        ⚠ 100,000건 선택 시 브라우저가 수 초간 멈춥니다
      </p>

      {/* 측정 결과 */}
      {metrics && (
        <div className="border border-border rounded-lg p-4 mb-6 font-mono text-sm space-y-1.5">
          <Row label="렌더링 건수" value={metrics.count.toLocaleString()} />
          <Row label="Fetch 시간" value={`${Math.round(metrics.fetchMs)} ms`} />
          <Row label="React 렌더" value={`${metrics.renderMs} ms`} />
          <Row
            label="총 소요"
            value={`${Math.round(metrics.fetchMs + metrics.renderMs)} ms`}
          />
          <Row
            label="JS Heap"
            value={
              metrics.heapMB !== null
                ? `${metrics.heapMB} MB`
                : "측정 불가 (Chrome 전용)"
            }
          />
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground mb-4 font-mono">
          fetch 중...
        </p>
      )}

      {/* 목록 */}
      {items.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <NaiveBulkList
            items={items}
            onRenderComplete={handleRenderComplete}
          />
        </div>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
