"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

/**
 * QR to the PUBLIC verification page for this transcript. The origin is read
 * in the browser rather than hard-coded, so a preview deploy's QR points at the
 * preview and not at production (where the code would resolve differently).
 * Renders a same-sized blank box until mounted, so nothing shifts on hydration.
 */
export function VerifyQr({ code }: { code: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(`${window.location.origin}/verify/${encodeURIComponent(code)}`);
  }, [code]);

  return (
    <div className="h-[88px] w-[88px] bg-white">
      {url && <QRCodeSVG value={url} size={88} level="M" />}
    </div>
  );
}
