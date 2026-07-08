"use client";

import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Derive a single-character initial from a display name or id (uppercased). Uses
 * the first Unicode code point so a CJK name / emoji renders one whole glyph
 * rather than a broken surrogate half. Falls back to `?` when nothing is given.
 */
function initialOf(source: string | undefined): string {
  const trimmed = source?.trim() ?? "";
  if (trimmed.length === 0) return "?";
  return [...trimmed][0]!.toUpperCase();
}

interface AvatarProps {
  /**
   * Image URL. When absent, empty, or it fails to load, the initial-letter
   * fallback is shown instead. (Feishu avatar URLs are public CDN links; a
   * broken/expired one degrades gracefully via `onError`.)
   */
  readonly src?: string | undefined;
  /** Display name — drives the initial-letter fallback and the `alt` text. */
  readonly name?: string | undefined;
  /** Stable id used for the initial when no name is available. */
  readonly fallbackId?: string | undefined;
  readonly size?: "sm" | "md";
  readonly className?: string | undefined;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "size-6 text-[.625rem]",
  md: "size-8 text-xs",
};

/**
 * A small circular avatar: renders `src` when it loads, otherwise an
 * initial-letter chip on a muted background. Theme-aware via design tokens
 * (`bg-muted` / `text-muted-foreground`). No dependency on any remote asset
 * beyond `src` itself, so it stays inert until the image loads.
 *
 * `failedSrc` tracks the URL that failed rather than a boolean, so a later
 * `src` change (e.g. a re-bind swapping the bot's avatar) re-attempts the image
 * instead of staying stuck on the fallback.
 */
export function Avatar({ src, name, fallbackId, size = "md", className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initial = initialOf(name ?? fallbackId);
  const showImage = src !== undefined && src.length > 0 && failedSrc !== src;
  return (
    <span
      data-slot="avatar"
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={name ?? ""}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        <span aria-hidden>{initial}</span>
      )}
    </span>
  );
}
