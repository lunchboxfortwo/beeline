import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QrTiles } from '@/ui/grammar';

/** One QR module, in points. The quiet zone around the code is one module. */
const QR_MODULE = 6;

/**
 * The wallet QR — the pure-JS matrix from `qrcode` painted as a grid of
 * tiles (no canvas, no WebView), shared by the receive screen and the
 * wallet dashboard's receive tab. A payload that cannot encode renders the
 * same-size placeholder frame, never a broken image.
 */
export function WalletQr({ payload, size = 180 }: { payload: string; size?: number }) {
  const [modules, setModules] = useState<{
    size: number;
    get: (row: number, col: number) => number;
  } | null>(null);

  useEffect(() => {
    if (!payload) return;
    try {
      setModules(QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules);
    } catch {
      setModules(null);
    }
  }, [payload]);

  if (!modules) {
    return <QrTiles count={0} module={QR_MODULE} size={size} testID="wallet-qr-placeholder" />;
  }
  return (
    <QrTiles
      count={modules.size}
      dark={(row, col) => Boolean(modules.get(row, col))}
      module={QR_MODULE}
      testID="wallet-qr"
    />
  );
}
