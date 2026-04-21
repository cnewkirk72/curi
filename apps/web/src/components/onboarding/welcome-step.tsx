'use client';

// First onboarding step — brand hero + welcome copy + "Begin" CTA.
//
// Visual anchor is an inline re-creation of /public/icon.svg scaled
// up to ~96pt with a soft glow. We inline it rather than <img
// src="/icon.svg"> for two reasons:
//   1. We want the stroke to animate in (stroke-dashoffset) and
//      external SVGs can't be stroked from CSS unless you bother
//      with <object> or server-side fragment injection.
//   2. Inline SVG means the glow filter colors stay consistent with
//      the rest of the page's cyan accent even if the SVG asset
//      gets swapped later.
//
// Stagger: logo (0ms) → eyebrow (120ms) → headline (200ms)
//         → body (320ms) → CTA (460ms).
// The delays are tuned so the composition reads as a single arrival
// rather than five separate fades. Reduced-motion skips the delays
// entirely and everything mounts at once.

import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AmbientBlobs } from './ambient-blobs';

type Props = {
  onBegin: () => void;
};

export function WelcomeStep({ onBegin }: Props) {
  return (
    <div className="relative flex min-h-[calc(100dvh-8rem)] flex-col items-center justify-center overflow-hidden px-5 text-center">
      <AmbientBlobs calm />

      <div className="relative flex flex-col items-center gap-6">
        <CuriLogoMark className="animate-enter-scale" />

        <div className="flex flex-col items-center gap-3">
          <p
            className="font-display text-2xs uppercase tracking-widest text-accent animate-enter-up motion-reduce:animate-none"
            style={{ animationDelay: '120ms', animationFillMode: 'both' }}
          >
            curi — NYC
          </p>
          <h1
            className="max-w-xs font-display text-3xl font-semibold leading-tight tracking-display animate-enter-up motion-reduce:animate-none"
            style={{ animationDelay: '200ms', animationFillMode: 'both' }}
          >
            Music nights,
            <br />
            picked for your taste.
          </h1>
          <p
            className="max-w-sm text-sm text-fg-muted animate-enter-up motion-reduce:animate-none"
            style={{ animationDelay: '320ms', animationFillMode: 'both' }}
          >
            Answer a few quick questions and curi will tune the feed
            to what you&apos;re into — no doom-scroll, no random noise.
          </p>
        </div>

        <button
          type="button"
          onClick={onBegin}
          className={cn(
            'mt-4 inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-7 py-3.5',
            'font-display text-sm font-semibold text-bg-deep shadow-glow',
            'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
            'animate-enter-up motion-reduce:animate-none',
          )}
          style={{ animationDelay: '460ms', animationFillMode: 'both' }}
        >
          Begin
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>

      <p
        className="relative mt-10 font-display text-2xs uppercase tracking-widest text-fg-dim tabular animate-fade-in motion-reduce:animate-none"
        style={{ animationDelay: '680ms', animationFillMode: 'both' }}
      >
        v0.1 · NYC · /curi
      </p>
    </div>
  );
}

// ── Curi logo mark, inline ────────────────────────────────────────────────
//
// Mirrors public/icon.svg but scaled for hero use and with an SVG
// drop-shadow filter tuned to the cyan accent. If the brand mark
// in /public ever changes, update both places.

function CuriLogoMark({ className }: { className?: string }) {
  return (
    <div className={cn('relative h-24 w-24', className)}>
      {/* Radial glow ring underneath */}
      <div
        aria-hidden
        className="absolute inset-[-12px] rounded-full bg-accent/25 blur-2xl"
      />
      <svg
        viewBox="0 0 512 512"
        className="relative h-full w-full"
        aria-label="Curi logo"
        role="img"
      >
        <defs>
          <radialGradient id="curi-welcome-g" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.28" />
            <stop offset="60%" stopColor="#22D3EE" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="512" height="512" rx="104" fill="#05070D" />
        <circle cx="256" cy="256" r="200" fill="url(#curi-welcome-g)" />
        <path
          d="M 374 162 A 136 136 0 1 0 374 350"
          stroke="#22D3EE"
          strokeWidth="56"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="382" cy="256" r="18" fill="#22D3EE" />
      </svg>
    </div>
  );
}
