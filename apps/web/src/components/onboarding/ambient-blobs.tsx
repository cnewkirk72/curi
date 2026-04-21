// Ambient brand background — the cyan + violet blob pair used on
// /login and the home placeholder. Pulled out here so onboarding
// steps can drop in the exact same recipe without re-declaring
// blur radii and delay values.
//
// Purely presentational — no props beyond className, no state. The
// container is `position:absolute` so callers wrap it in a
// `relative` parent (every onboarding step screen does).

import { cn } from '@/lib/utils';

type Props = {
  /** Extra classes on the outer fragment container. Rare to override
   * — exposed for the welcome step which wants the blobs tinted
   * slightly brighter than the rest of the flow. */
  className?: string;
  /** When true, both blobs pulse more slowly so the welcome hero
   * feels less busy. Defaults to the snappier 6s cadence used
   * everywhere else. */
  calm?: boolean;
};

export function AmbientBlobs({ className, calm = false }: Props) {
  const delaySecond = calm ? '9s' : '6s';
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      <div
        className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl animate-blob"
      />
      <div
        className="absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-violet/20 blur-3xl animate-blob"
        style={{ animationDelay: delaySecond }}
      />
    </div>
  );
}
