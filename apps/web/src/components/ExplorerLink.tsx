import type { ReactNode } from 'react';
import { explorerUrl, type ExplorerEntity } from '../explorer.js';

interface Props {
  network: string;
  entity: ExplorerEntity;
  value: string;
  children: ReactNode;
  className?: string;
  title?: string;
}

/**
 * A link to the explorer for the selected network. When that network has no
 * explorer configured the children render as plain text, so the layout and the
 * information on screen are identical either way — only the affordance differs.
 */
export function ExplorerLink({
  network, entity, value, children, className, title,
}: Props): React.JSX.Element {
  const href = explorerUrl(network, entity, value);
  if (!href) return <>{children}</>;

  return (
    <a
      className={className ? `explorer-link ${className}` : 'explorer-link'}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={title ?? `Open this ${entity} on the ${network} explorer`}
      // The row itself toggles its expanded state, so following the link must
      // not also collapse the row it came from.
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}
