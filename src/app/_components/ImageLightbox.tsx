"use client";

import { useState } from "react";
import Image from "next/image";
import { Expand, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "~/components/ui/dialog";

/**
 * A cropped image that opens to its full, uncropped self when clicked.
 *
 * WHY THIS EXISTS. Banners are rendered with `object-cover` into containers
 * whose aspect ratio moves with the viewport — the resident page is roughly 6:1
 * on a desktop and 2.8:1 on a phone, against a 4:1 upload box — so a third of
 * the height or a third of the width is cropped away and NOTHING in the app
 * showed the whole picture. Heads design these banners; they should be able to
 * see the thing they uploaded.
 *
 * `object-contain` INSIDE A FIXED BOX, not a naturally-sized <img>. The intrinsic
 * dimensions are not known here: the upload pipeline scales to FIT inside
 * 1600x400 preserving ratio, so a 16:9 original lands at 711x400 and a square one
 * at 400x400. Passing fixed width/height to next/image would declare a ratio the
 * file does not have and render it STRETCHED. `fill` + `object-contain` letter-
 * boxes whatever the real ratio is, undistorted, without needing to know it.
 *
 * `unoptimized` matches how these are already rendered: the blobs are pre-scaled
 * WebP, so the image optimizer would spend a transformation to save almost
 * nothing.
 */
export default function ImageLightbox({
  src,
  alt,
  title,
  className,
  priority = false,
  sizes = "100vw",
}: {
  src: string;
  /** Decorative in context — the accessible name lives on the button. */
  alt?: string;
  /** Names the button and the dialog, e.g. "Chess Club banner". */
  title: string;
  /** Sizing/rounding for the CROPPED trigger. The caller owns the shape. */
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  const [open, setOpen] = useState(false);
  /**
   * The image's real pixel size, learned on load, used to CAP the frame.
   *
   * Without it `object-contain` happily scales a small image UP to fill the
   * viewport box: an upload that arrived as 711x400 (a 16:9 original, shrunk to
   * fit the 1600x400 box by its height) would be blown up to ~1.7x and shown
   * soft — a worse view of the picture than the cropped one it replaced. Capping
   * the frame at the natural size means "full image" tops out at 1:1.
   */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${title} — view full image`}
        className={`group cursor-zoom-in ${className ?? ""}`}
      >
        <Image
          src={src}
          alt={alt ?? ""}
          fill
          className="object-cover"
          sizes={sizes}
          unoptimized
          priority={priority}
        />
        {/* Affordance. Nothing else on these cards is clickable, so without a
            hint the interaction is undiscoverable. Appears on hover AND on
            keyboard focus — focus-within would not fire, the button itself is
            what receives focus. */}
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus:opacity-100"
        >
          <Expand className="h-3.5 w-3.5" />
          Full image
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          // Strip the panel chrome — max-w-lg, border, background, padding — so
          // the image is the dialog rather than sitting inside a card. The
          // built-in close button is hidden the same way EditProfileModal hides
          // it; a dark icon on an arbitrary image is unreadable, so this
          // supplies its own with a scrim behind it.
          className="w-auto max-w-none border-0 bg-transparent p-0 shadow-none [&>button.absolute]:hidden"
          onClick={() => setOpen(false)}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div
            className="relative h-[85vh] w-[92vw] cursor-zoom-out"
            style={
              natural
                ? { maxWidth: natural.w, maxHeight: natural.h }
                : undefined
            }
          >
            <Image
              src={src}
              alt={title}
              fill
              className="object-contain"
              sizes="92vw"
              unoptimized
              onLoad={(e) =>
                setNatural({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
            />
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute right-2 top-2 rounded-full bg-black/55 p-2 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus:outline-none focus:ring-2 focus:ring-white/70"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
