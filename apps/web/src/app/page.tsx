// Phase-1 placeholder. Discover screen is built in Phase 3.
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-between p-6">
      <header className="flex w-full items-center justify-between">
        <h1 className="font-mono text-lg tracking-tight">curi</h1>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wider text-muted-foreground">
          NYC
        </span>
      </header>

      <section className="mt-24 space-y-4">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Phase 1 / scaffolding
        </p>
        <h2 className="text-3xl font-semibold leading-tight">
          Electronic music events,
          <br />
          filtered the way you listen.
        </h2>
        <p className="text-sm text-muted-foreground">
          Discover UI ships in Phase 3. Ingestion starts in Phase 2.
        </p>
      </section>

      <footer className="mt-12 w-full font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        v0.1 · NYC · /curi
      </footer>
    </main>
  );
}
