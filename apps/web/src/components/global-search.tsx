'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function GlobalSearch({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep input in sync if URL changes externally (e.g. clear-all filters)
  useEffect(() => {
    setValue(searchParams.get('q') ?? '');
  }, [searchParams]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (v.trim()) {
        params.set('q', v.trim());
      } else {
        params.delete('q');
      }
      router.replace(`/?${params.toString()}`);
    }, 350);
  }

  function clear() {
    setValue('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    router.replace(`/?${params.toString()}`);
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-pill px-3 py-2',
        'border border-border bg-bg-elevated',
        'transition-colors duration-micro focus-within:border-accent/50',
        className,
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <input
        type="search"
        value={value}
        onChange={handleChange}
        placeholder="Search events, artists, venues…"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-xs text-fg-primary outline-none',
          'placeholder:text-fg-dim',
          '[&::-webkit-search-cancel-button]:hidden',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="shrink-0 text-fg-muted transition-colors hover:text-fg-primary"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
