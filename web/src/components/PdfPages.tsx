import { useEffect, useRef, useState } from 'react';
import { Loader, Stack, Text } from '@mantine/core';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Renders every page of a PDF to canvases. Used instead of the browser's own
 * PDF viewer, which is missing on phones and some embedded browsers.
 */
export function PdfPages({ src }: { src: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url: src, withCredentials: true });
    const el = container.current!;
    el.replaceChildren();
    setState('loading');

    task.promise
      .then(async (pdf) => {
        const width = el.clientWidth || 800;
        for (let n = 1; n <= pdf.numPages && !cancelled; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const ratio = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = '100%';
          canvas.style.border = '1px solid var(--mantine-color-default-border)';
          canvas.style.background = '#fff';
          el.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!cancelled) setState('ready');
      })
      .catch(() => !cancelled && setState('error'));

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [src]);

  return (
    <Stack gap="xs">
      {state === 'loading' && <Loader />}
      {state === 'error' && <Text c="red">This PDF could not be displayed. Use Download to open it instead.</Text>}
      <div ref={container} style={{ display: 'flex', flexDirection: 'column', gap: 12 }} />
    </Stack>
  );
}
