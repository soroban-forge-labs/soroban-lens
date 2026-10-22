import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  label: string;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard is unavailable');
}

/** Copy an identifier without allowing the parent event row to expand. */
export function CopyButton({ value, label }: Props): React.JSX.Element {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (timer.current) clearTimeout(timer.current);
    try {
      await copyText(value);
      setStatus('Copied');
    } catch {
      setStatus('Copy failed');
    }
    timer.current = setTimeout(() => setStatus(''), 1800);
  }

  return (
    <span className="copy-control">
      <button
        type="button"
        className="copy-button"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={handleCopy}
      >
        Copy
      </button>
      <span className="copy-status" role="status" aria-live="polite">{status}</span>
    </span>
  );
}
